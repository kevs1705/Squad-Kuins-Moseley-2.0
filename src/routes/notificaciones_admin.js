// routes/notificaciones.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');

// middleware simple para rol admin (rol=1)
function requireRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.rol === role) return next();
    return res.status(403).send('No autorizado');
  };
}

/**
 * Vista: lista todas las notificaciones (para admin)
 * Si quieres ver solo pendientes: agrega WHERE n.estado = 1
 */
router.get('/notificaciones_admin', requireAuth, requireRole(1), async (req, res) => {
  const [rows] = await db.query(
    `SELECT 
      n.id_notificacion, n.id_usuario, u.nombre AS nombre_usuario,
      DATE_FORMAT(n.fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
      DATE_FORMAT(n.hora_inicio, '%H:%i') AS hora_inicio,
      DATE_FORMAT(n.hora_fin, '%H:%i') AS hora_fin,
      n.motivo, n.estado,
      n.observacion_admin,
      DATE_FORMAT(n.creado_en, '%Y-%m-%d %H:%i:%s') AS creado_en,
      DATE_FORMAT(n.actualizado_en, '%Y-%m-%d %H:%i:%s') AS actualizado_en
   FROM notificaciones n
   JOIN usuarios u ON u.id_usuario = n.id_usuario
   ORDER BY n.creado_en DESC`
  );

  res.render('notificaciones_admin', { user: req.session.user, notifs: rows });
});

/**
 * Aprobar notificación: inserta en reportes y marca estado=2 (Aprobado)
 * Body: { obs: "texto opcional del admin" }
 */
router.post('/notificaciones/:id/approve', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Leer notificacion (solo si está pendiente)
    const [rows] = await conn.query(
      `SELECT id_notificacion, id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, estado
       FROM notificaciones WHERE id_notificacion = ? FOR UPDATE`,
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, msg: 'Notificación no encontrada' });
    }
    const n = rows[0];
    if (Number(n.estado) !== 1) {
      await conn.rollback();
      return res.status(400).json({ ok: false, msg: 'La solicitud ya no está pendiente' });
    }

    // Insert en reportes (hora_acumulada = TIMEDIFF(hora_fin, hora_inicio))
    // Observación: "Horas extra: <motivo>" (+ observación admin si hay)
    const observacion = `Horas extra: ${n.motivo || ''}${obs ? ' | Obs: ' + obs : ''}`;

    await conn.query(
      `INSERT INTO reportes
        (id_usuario, fecha, hora_acumulada, hora_inicio, hora_fin, tarea, observacion)
       VALUES
        (?, ?, TIMEDIFF(?, ?), ?, ?, ?, ?)`,
      [
        n.id_usuario,
        n.fecha_solicitada,
        n.hora_fin, n.hora_inicio, // TIMEDIFF(fin, inicio)
        n.hora_inicio,
        n.hora_fin,
        'Horas extra',
        observacion
      ]
    );

    // Marcar notificación como aprobada
    await conn.query(
      `UPDATE notificaciones
         SET estado = 2, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ?`,
      [obs || null, id]
    );

    await conn.commit();
    return res.json({ ok: true, msg: 'Aprobada e insertada en reportes' });
  } catch (e) {
    console.error('approve error:', e);
    await conn.rollback();
    return res.status(500).json({ ok: false, msg: 'Error aprobando' });
  } finally {
    conn.release();
  }
});

/**
 * Rechazar notificación: solo actualiza estado=3 (Rechazado)
 * Body: { obs: "texto opcional del admin" }
 */
router.post('/notificaciones/:id/reject', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  try {
    const [r] = await db.query(
      `UPDATE notificaciones
         SET estado = 3, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ? AND estado = 1`,
      [obs || null, id]
    );

    if (r.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'No se pudo rechazar (¿ya no está pendiente?)' });
    }
    return res.json({ ok: true, msg: 'Rechazada' });
  } catch (e) {
    console.error('reject error:', e);
    return res.status(500).json({ ok: false, msg: 'Error rechazando' });
  }
});

module.exports = router;
