// routes/notificaciones.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');

// middleware simple para rol admin (rol=1)
function requireRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.rol === role) return next();
    if (req.xhr || req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ ok: false, msg: 'No autorizado' });
    }
    return res.status(403).render('error', {
      statusCode: 403,
      title: 'No autorizado',
      message: 'No cuentas con permisos de administrador para gestionar notificaciones.'
    });
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

    // 4. Pasantes disponibles con menos de 280 horas acumuladas
    const pasantesDisponibles = await getPasantesDisponibles();

    res.render('notificaciones_admin', { 
      user: req.session.user, 
      notifs: notifs || [],
      teletrabajos: teletrabajos || [],
      jornadasObservadas: jornadasObservadas || [],
      pasantesDisponibles: pasantesDisponibles || []
    });
  } catch (error) {
    console.error('Error al cargar panel de notificaciones admin:', error);
    res.status(500).render('error', {
      statusCode: 500,
      title: 'Error en la base de datos',
      message: 'Error interno al cargar solicitudes y notificaciones desde la base de datos.'
    });
  }
});

/**
 * Helper: Obtener pasantes activos con menos de 280 horas acumuladas
 */
async function getPasantesDisponibles() {
  const [pasantes] = await db.query(`
    SELECT 
      u.id_usuario, 
      TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno)) AS nombre_completo,
      u.CI,
      ROUND((COALESCE(asist.total_seg, 0) + COALESCE(he.total_seg_he, 0)) / 3600, 1) AS horas_acumuladas,
      ROUND(GREATEST(0, 280 - ((COALESCE(asist.total_seg, 0) + COALESCE(he.total_seg_he, 0)) / 3600)), 1) AS horas_restantes
    FROM usuarios u
    LEFT JOIN (
      SELECT 
        id_usuario,
        SUM(TIMESTAMPDIFF(SECOND, TIMESTAMP(fecha, hora_entrada), TIMESTAMP(fecha, hora_salida))) AS total_seg
      FROM asistencias
      WHERE estado NOT IN ('ANULADO', 'OBSERVADO', 'RECHAZADO')
        AND hora_entrada IS NOT NULL AND hora_salida IS NOT NULL
      GROUP BY id_usuario
    ) asist ON asist.id_usuario = u.id_usuario
    LEFT JOIN (
      SELECT 
        id_usuario,
        SUM(TIMESTAMPDIFF(SECOND, TIMESTAMP(fecha_solicitada, hora_inicio), TIMESTAMP(fecha_solicitada, hora_fin)) * 2) AS total_seg_he
      FROM notificaciones
      WHERE estado = 2
        AND hora_inicio IS NOT NULL AND hora_fin IS NOT NULL
      GROUP BY id_usuario
    ) he ON he.id_usuario = u.id_usuario
    WHERE (u.rol = 0 OR u.rol IS NULL)
      AND u.estado = 1
      AND ((COALESCE(asist.total_seg, 0) + COALESCE(he.total_seg_he, 0)) / 3600) < 280
    ORDER BY u.nombre ASC, u.apellido_paterno ASC
  `);
  return pasantes || [];
}

/**
 * GET /api/admin/horas-extras/pasantes-disponibles
 * Devuelve lista JSON de pasantes que tienen menos de 280 horas acumuladas
 */
router.get('/api/admin/horas-extras/pasantes-disponibles', requireAuth, requireRole(1), async (req, res) => {
  try {
    const pasantes = await getPasantesDisponibles();
    return res.json({ ok: true, pasantes });
  } catch (error) {
    console.error('Error al consultar pasantes disponibles:', error);
    return res.status(500).json({ ok: false, msg: 'Error al consultar pasantes disponibles.' });
  }
});

/**
 * POST /api/admin/horas-extras/asignar
 * Asigna una nueva sesión de horas extras a un pasante (<280h) con bitácora vacía para que el pasante la llene
 */
router.post('/api/admin/horas-extras/asignar', requireAuth, requireRole(1), async (req, res) => {
  try {
    const { id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo } = req.body;
    
    const idUsuarioNum = parseInt(id_usuario, 10);
    if (!idUsuarioNum) {
      return res.status(400).json({ ok: false, msg: 'Debes seleccionar un pasante válido.' });
    }

    const fecha = String(fecha_solicitada || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ ok: false, msg: 'Fecha inválida. Debe ser en formato YYYY-MM-DD.' });
    }

    let hIni = String(hora_inicio || '').trim().slice(0, 8);
    let hFin = String(hora_fin || '').trim().slice(0, 8);
    if (!hIni || !hFin) {
      return res.status(400).json({ ok: false, msg: 'Debes especificar tanto la hora de inicio como la de fin.' });
    }
    if (hIni.length === 5) hIni += ':00';
    if (hFin.length === 5) hFin += ':00';

    if (hIni >= hFin) {
      return res.status(400).json({ ok: false, msg: 'La hora de fin debe ser posterior a la hora de inicio.' });
    }

    // Calcular cantidad de horas en decimal
    const [diffRows] = await db.query(
      `SELECT ROUND(TIMESTAMPDIFF(SECOND, TIMESTAMP(?, ?), TIMESTAMP(?, ?)) / 3600, 2) AS horas_calc`,
      [fecha, hIni, fecha, hFin]
    );
    const horasCantidad = diffRows[0]?.horas_calc || 0;

    const motivoFinal = String(motivo || 'Horas extras asignadas por Administración').trim();
    const obsAdmin = 'EDITADO POR EL ADMIN, REQUIERE QUE SE AGREGUE BITACORA';

    const [insertRes] = await db.query(
      `INSERT INTO notificaciones 
        (id_usuario, fecha_solicitada, hora_inicio, hora_fin, horas_cantidad, motivo, tarea, comprobante, estado, observacion_admin)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
      [idUsuarioNum, fecha, hIni, hFin, horasCantidad, motivoFinal, obsAdmin]
    );

    return res.json({ 
      ok: true, 
      msg: 'Horas extras asignadas exitosamente al pasante. Queda pendiente para que el pasante complete su bitácora.',
      id_notificacion: insertRes.insertId 
    });
  } catch (err) {
    console.error('Error al asignar horas extras:', err);
    return res.status(500).json({ ok: false, msg: 'Error interno del servidor al asignar horas extras.' });
  }
});

/**
 * Aprobar notificación (Horas Extra): marca estado=2 (Aprobado / Horas Sumadas)
 * Body: { obs: "texto opcional del admin" }
 */
router.post('/notificaciones/:id/approve', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  try {
    // Leer notificacion
    const [rows] = await db.query(
      `SELECT id_notificacion, id_usuario, fecha_solicitada, hora_inicio, hora_fin, horas_cantidad, motivo, tarea, comprobante, estado
       FROM notificaciones WHERE id_notificacion = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, msg: 'Reporte de horas extra no encontrado' });
    }
    const n = rows[0];
    if (Number(n.estado) === 2) {
      return res.status(400).json({ ok: false, msg: 'Las horas ya han sido sumadas y aprobadas anteriormente.' });
    }

    // Marcar notificación como aprobada
    await db.query(
      `UPDATE notificaciones
         SET estado = 2, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ?`,
      [obs || null, id]
    );

    return res.json({ ok: true, msg: 'Horas extras aprobadas y acreditadas exitosamente al total acumulado.' });
  } catch (e) {
    console.error('approve error:', e);
    return res.status(500).json({ ok: false, msg: 'Error aprobando horas extra' });
  }
});

/**
 * Deshacer suma de horas extra: vuelve estado a 1 (Pendiente)
 */
router.post('/notificaciones/:id/revert', requireAuth, requireRole(1), async (req, res) => {
  const id = Number(req.params.id);
  const obs = String(req.body?.obs || '').trim();

  try {
    const [rows] = await db.query(
      `SELECT id_notificacion, estado FROM notificaciones WHERE id_notificacion = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, msg: 'Reporte de horas extra no encontrado' });
    }

    // Regresar notificación a estado pendiente
    await db.query(
      `UPDATE notificaciones
         SET estado = 1, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_notificacion = ?`,
      [obs ? `Suma revertida | Obs: ${obs}` : null, id]
    );

    return res.json({ ok: true, msg: 'Suma de horas revertida exitosamente. El reporte vuelve a estar pendiente de evaluación.' });
  } catch (e) {
    console.error('revert error:', e);
    return res.status(500).json({ ok: false, msg: 'Error al deshacer suma de horas extra' });
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
