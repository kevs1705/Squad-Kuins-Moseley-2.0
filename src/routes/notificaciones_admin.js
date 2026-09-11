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
  try {
    // 1. Solicitudes de horas extra
    const [notifs] = await db.query(
      `SELECT 
        n.id_notificacion, n.id_usuario, u.nombre AS nombre_usuario, u.CI AS ci_usuario,
        DATE_FORMAT(n.fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        DATE_FORMAT(n.hora_inicio, '%H:%i') AS hora_inicio,
        DATE_FORMAT(n.hora_fin, '%H:%i') AS hora_fin,
        n.horas_cantidad,
        n.motivo,
        n.tarea,
        n.comprobante,
        n.estado,
        n.observacion_admin,
        IF(n.hora_fin IS NOT NULL AND n.hora_inicio IS NOT NULL,
           TIME_FORMAT(TIMEDIFF(n.hora_fin, n.hora_inicio), '%H:%i'),
           '00:00'
        ) AS duracion_calculada,
        DATE_FORMAT(n.creado_en, '%Y-%m-%d %H:%i:%s') AS creado_en,
        DATE_FORMAT(n.actualizado_en, '%Y-%m-%d %H:%i:%s') AS actualizado_en
      FROM notificaciones n
      JOIN usuarios u ON u.id_usuario = n.id_usuario
      ORDER BY (n.estado = 1) DESC, n.creado_en DESC`
    );

    // 2. Solicitudes de Teletrabajo (Fase 1: Pre-autorización)
    const [teletrabajos] = await db.query(
      `SELECT 
        s.id_solicitud, s.id_usuario, u.nombre AS nombre_usuario, u.CI AS ci_usuario,
        DATE_FORMAT(s.fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        TIME_FORMAT(s.hora_inicio, '%H:%i') AS hora_inicio,
        TIME_FORMAT(s.hora_fin, '%H:%i') AS hora_fin,
        s.motivo, s.direccion_remota, s.estado,
        s.observacion_admin,
        DATE_FORMAT(s.creado_en, '%Y-%m-%d %H:%i:%s') AS creado_en
      FROM solicitudes_teletrabajo s
      JOIN usuarios u ON u.id_usuario = s.id_usuario
      ORDER BY (s.estado = 1) DESC, s.fecha_solicitada DESC, s.creado_en DESC`
    );

    // 3. Jornadas de Teletrabajo (Auditoría, Aprobadas/Sumadas y Observadas)
    const [jornadasObservadas] = await db.query(
      `SELECT 
        a.id_asistencia,
        a.id_usuario,
        u.nombre AS usuario_nombre,
        u.CI AS usuario_ci,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
        TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
        COALESCE(ag.modalidad, 'TELETRABAJO') AS modalidad,
        a.estado AS asistencia_estado,
        ag.lat_entrada,
        ag.lng_entrada,
        ag.lat_salida,
        ag.lng_salida,
        a.observacion AS asistencia_observacion,
        
        st.direccion_remota,
        st.motivo AS motivo_solicitud,
        
        r.id_reporte,
        r.tarea,
        r.comprobante,
        r.observacion AS reporte_observacion,
        
        IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
           TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i'),
           '00:00'
        ) AS horas_calculadas
      FROM asistencias a
      INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
      LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
      LEFT JOIN solicitudes_teletrabajo st ON st.id_solicitud = ag.id_solicitud_teletrabajo
      LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
      LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
      WHERE (ag.modalidad = 'TELETRABAJO' OR ag.id_geo IS NOT NULL OR l.tipo = 'TELETRABAJO' OR l.nombre = 'Teletrabajo')
        AND a.estado != 'ANULADO'
      ORDER BY (a.estado = 'OBSERVADO') DESC, a.fecha DESC, a.hora_entrada DESC`
    );

    res.render('notificaciones_admin', { 
      user: req.session.user, 
      notifs: notifs || [],
      teletrabajos: teletrabajos || [],
      jornadasObservadas: jornadasObservadas || []
    });
  } catch (error) {
    console.error('Error al cargar panel de notificaciones admin:', error);
    res.status(500).send('Error interno al cargar solicitudes.');
  }
});

/**
 * Aprobar notificación (Horas Extra): inserta en reportes y marca estado=2 (Aprobado / Horas Sumadas)
 * Body: { obs: "texto opcional del admin" }
 */
router.post('/notificaciones/:id/approve', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Leer notificacion
    const [rows] = await conn.query(
      `SELECT id_notificacion, id_usuario, fecha_solicitada, hora_inicio, hora_fin, horas_cantidad, motivo, tarea, comprobante, estado
       FROM notificaciones WHERE id_notificacion = ? FOR UPDATE`,
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, msg: 'Reporte de horas extra no encontrado' });
    }
    const n = rows[0];
    if (Number(n.estado) === 2) {
      await conn.rollback();
      return res.status(400).json({ ok: false, msg: 'Las horas ya han sido sumadas y aprobadas anteriormente.' });
    }

    // Preparar descripción y tarea
    const tareaReporte = n.tarea || n.motivo || 'Horas extras autorizadas';
    const observacionReporte = `Horas extras aprobadas${n.motivo ? ' - Justificación: ' + n.motivo : ''}${obs ? ' | Obs Admin: ' + obs : ''}`;

    // Insertar en reportes para integrar al total acumulado oficial
    await conn.query(
      `INSERT INTO reportes
        (id_usuario, fecha, hora_acumulada, hora_inicio, hora_fin, tarea, comprobante, observacion)
       VALUES
        (?, ?, TIMEDIFF(?, ?), ?, ?, ?, ?, ?)`,
      [
        n.id_usuario,
        n.fecha_solicitada,
        n.hora_fin, n.hora_inicio,
        n.hora_inicio,
        n.hora_fin,
        tareaReporte,
        n.comprobante || null,
        observacionReporte
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
    return res.json({ ok: true, msg: 'Horas extras aprobadas y acreditadas exitosamente al total acumulado.' });
  } catch (e) {
    console.error('approve error:', e);
    await conn.rollback();
    return res.status(500).json({ ok: false, msg: 'Error aprobando horas extra' });
  } finally {
    conn.release();
  }
});

/**
 * Deshacer suma de horas extra: elimina el registro insertado en reportes y vuelve estado a 1 (Pendiente)
 */
router.post('/notificaciones/:id/revert', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id_notificacion, id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, tarea, estado
       FROM notificaciones WHERE id_notificacion = ? FOR UPDATE`,
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, msg: 'Reporte de horas extra no encontrado' });
    }
    const n = rows[0];

    const tareaReporte = n.tarea || n.motivo || 'Horas extras autorizadas';

    // Eliminar el registro generado en reportes
    await conn.query(
      `DELETE FROM reportes 
       WHERE id_usuario = ? AND fecha = ? AND (tarea = ? OR tarea = 'Horas extra' OR tarea = 'Horas extras autorizadas') AND hora_inicio = ? AND hora_fin = ?
       ORDER BY id_reporte DESC LIMIT 1`,
      [n.id_usuario, n.fecha_solicitada, tareaReporte, n.hora_inicio, n.hora_fin]
    );

    // Regresar notificación a estado pendiente
    await conn.query(
      `UPDATE notificaciones
         SET estado = 1, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ?`,
      [obs ? `Suma revertida | Obs: ${obs}` : null, id]
    );

    await conn.commit();
    return res.json({ ok: true, msg: 'Suma de horas revertida exitosamente. El reporte vuelve a estar pendiente de evaluación.' });
  } catch (e) {
    console.error('revert error:', e);
    await conn.rollback();
    return res.status(500).json({ ok: false, msg: 'Error al deshacer suma de horas extra' });
  } finally {
    conn.release();
  }
});

/**
 * Rechazar / Observar notificación: actualiza estado=3 (Observado / Rechazado)
 * Body: { obs: "motivo de la observación o rechazo" }
 */
router.post('/notificaciones/:id/reject', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  try {
    const [r] = await db.query(
      `UPDATE notificaciones
         SET estado = 3, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ?`,
      [obs || 'Observado por administración', id]
    );

    if (r.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'No se pudo actualizar el estado de la notificación.' });
    }
    return res.json({ ok: true, msg: 'Horas extras marcadas como Observadas / Rechazadas. No se acreditaron horas.' });
  } catch (e) {
    console.error('reject error:', e);
    return res.status(500).json({ ok: false, msg: 'Error al observar o rechazar reporte de horas extra' });
  }
});

module.exports = router;
