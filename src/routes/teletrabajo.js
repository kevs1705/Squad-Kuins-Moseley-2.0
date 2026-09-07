// src/routes/teletrabajo.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');

// Middleware para rol administrador (rol = 1)
function requireAdmin(req, res, next) {
  if (req.session?.user?.rol === 1) return next();
  return res.status(403).json({ ok: false, msg: 'Acceso denegado: solo administradores.' });
}

/* ==========================================================================
   RUTAS DE USUARIO (PASANTE / EMPLEADO)
   ========================================================================== */

/**
 * POST /api/teletrabajo/solicitar
 * Crear una nueva solicitud de teletrabajo
 */
router.post('/api/teletrabajo/solicitar', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id || req.session.user.id_usuario;
    let { fecha_solicitada, hora_inicio, hora_fin, motivo, direccion_remota } = req.body;

    fecha_solicitada = String(fecha_solicitada || '').trim().slice(0, 10);
    hora_inicio = String(hora_inicio || '').trim().slice(0, 8);
    hora_fin = String(hora_fin || '').trim().slice(0, 8);
    motivo = String(motivo || '').trim();
    direccion_remota = String(direccion_remota || 'Domicilio particular').trim().slice(0, 255);

    // 1. Validar formato de fecha
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_solicitada)) {
      return res.status(400).json({ ok: false, msg: 'Fecha inválida. Debe ser formato YYYY-MM-DD.' });
    }

    // Validar que no sea fecha anterior a hoy
    const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/La_Paz' });
    if (fecha_solicitada < hoyStr) {
      return res.status(400).json({ ok: false, msg: 'No puedes solicitar teletrabajo para una fecha pasada.' });
    }

    // 2. Validar horas si se especifican
    if (hora_inicio && !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_inicio)) {
      return res.status(400).json({ ok: false, msg: 'Hora de inicio inválida (HH:MM).' });
    }
    if (hora_fin && !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_fin)) {
      return res.status(400).json({ ok: false, msg: 'Hora de fin inválida (HH:MM).' });
    }

    if (hora_inicio && hora_inicio.length === 5) hora_inicio += ':00';
    if (hora_fin && hora_fin.length === 5) hora_fin += ':00';

    if (hora_inicio && hora_fin && hora_inicio >= hora_fin) {
      return res.status(400).json({ ok: false, msg: 'La hora de fin debe ser posterior a la hora de inicio.' });
    }

    // 3. Validar motivo
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ ok: false, msg: 'Debes ingresar un motivo de al menos 5 caracteres justificando el teletrabajo.' });
    }

    // 4. Verificar si ya existe una solicitud para esa fecha (Pendiente o Aprobada)
    const [existentes] = await db.query(
      `SELECT id_solicitud, estado FROM solicitudes_teletrabajo 
       WHERE id_usuario = ? AND fecha_solicitada = ? AND estado IN (1, 2) LIMIT 1`,
      [userId, fecha_solicitada]
    );

    if (existentes && existentes.length > 0) {
      const estadoTxt = existentes[0].estado === 1 ? 'pendiente de revisión' : 'ya aprobada';
      return res.status(400).json({
        ok: false,
        msg: `Ya tienes una solicitud de teletrabajo ${estadoTxt} para el día ${fecha_solicitada}.`
      });
    }

    // 5. Insertar solicitud
    const [result] = await db.query(
      `INSERT INTO solicitudes_teletrabajo 
       (id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, direccion_remota, estado)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        userId,
        fecha_solicitada,
        hora_inicio || '08:00:00',
        hora_fin || '17:00:00',
        motivo,
        direccion_remota
      ]
    );

    return res.json({
      ok: true,
      msg: 'Solicitud de teletrabajo enviada con éxito. Pendiente de aprobación por el administrador.',
      id_solicitud: result.insertId
    });

  } catch (error) {
    console.error('Error al solicitar teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error interno del servidor al procesar la solicitud.' });
  }
});

/**
 * GET /api/teletrabajo/mis-solicitudes
 * Obtener las solicitudes de teletrabajo del usuario autenticado
 */
router.get('/api/teletrabajo/mis-solicitudes', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id || req.session.user.id_usuario;
    const [solicitudes] = await db.query(
      `SELECT 
        id_solicitud,
        DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio,
        TIME_FORMAT(hora_fin, '%H:%i') AS hora_fin,
        motivo,
        direccion_remota,
        estado,
        observacion_admin,
        DATE_FORMAT(creado_en, '%Y-%m-%d %H:%i') AS creado_en
       FROM solicitudes_teletrabajo
       WHERE id_usuario = ?
       ORDER BY fecha_solicitada DESC, creado_en DESC`,
      [userId]
    );

    return res.json({ ok: true, solicitudes });
  } catch (error) {
    console.error('Error al obtener solicitudes de teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error al consultar solicitudes.' });
  }
});

/**
 * GET /api/teletrabajo/estado-hoy
 * Consulta rápida si el usuario tiene permiso de teletrabajo aprobado para hoy
 */
router.get('/api/teletrabajo/estado-hoy', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id || req.session.user.id_usuario;
    const hoyStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/La_Paz' });

    const [rows] = await db.query(
      `SELECT 
        id_solicitud,
        DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio,
        TIME_FORMAT(hora_fin, '%H:%i') AS hora_fin,
        direccion_remota,
        motivo,
        estado
       FROM solicitudes_teletrabajo
       WHERE id_usuario = ? AND fecha_solicitada = ? AND estado = 2
       LIMIT 1`,
      [userId, hoyStr]
    );

    if (rows && rows.length > 0) {
      return res.json({ ok: true, tieneTeletrabajoHoy: true, permiso: rows[0] });
    } else {
      return res.json({ ok: true, tieneTeletrabajoHoy: false });
    }
  } catch (error) {
    console.error('Error al verificar teletrabajo hoy:', error);
    return res.status(500).json({ ok: false, msg: 'Error verificando permiso de teletrabajo.' });
  }
});

/* ==========================================================================
   RUTAS DE ADMINISTRADOR (GESTIÓN Y APROBACIÓN DE SOLICITUDES)
   ========================================================================== */

/**
 * GET /api/admin/teletrabajo/solicitudes
 * Listado de todas las solicitudes para el panel de administración
 */
router.get('/api/admin/teletrabajo/solicitudes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `
      SELECT 
        s.id_solicitud,
        s.id_usuario,
        u.nombre AS nombre_usuario,
        u.CI AS ci_usuario,
        DATE_FORMAT(s.fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        TIME_FORMAT(s.hora_inicio, '%H:%i') AS hora_inicio,
        TIME_FORMAT(s.hora_fin, '%H:%i') AS hora_fin,
        s.motivo,
        s.direccion_remota,
        s.estado,
        s.observacion_admin,
        DATE_FORMAT(s.creado_en, '%Y-%m-%d %H:%i:%s') AS creado_en
      FROM solicitudes_teletrabajo s
      JOIN usuarios u ON u.id_usuario = s.id_usuario
    `;

    const params = [];
    if (estado) {
      query += ` WHERE s.estado = ?`;
      params.push(Number(estado));
    }

    query += ` ORDER BY (s.estado = 1) DESC, s.fecha_solicitada DESC, s.creado_en DESC`;

    const [solicitudes] = await db.query(query, params);
    return res.json({ ok: true, solicitudes });
  } catch (error) {
    console.error('Error al obtener solicitudes admin teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error al consultar solicitudes.' });
  }
});

/**
 * POST /api/admin/teletrabajo/:id/approve
 * Aprobar una solicitud de teletrabajo
 */
router.post('/api/admin/teletrabajo/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const obs = String(req.body?.obs || '').trim();

    const [result] = await db.query(
      `UPDATE solicitudes_teletrabajo
       SET estado = 2, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_solicitud = ? AND estado = 1`,
      [obs || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'La solicitud no existe o ya fue procesada anteriormente.' });
    }

    return res.json({ ok: true, msg: 'Solicitud de teletrabajo APROBADA exitosamente.' });
  } catch (error) {
    console.error('Error al aprobar teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error interno al aprobar la solicitud.' });
  }
});

/**
 * POST /api/admin/teletrabajo/:id/reject
 * Rechazar una solicitud de teletrabajo
 */
router.post('/api/admin/teletrabajo/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const obs = String(req.body?.obs || '').trim();

    const [result] = await db.query(
      `UPDATE solicitudes_teletrabajo
       SET estado = 3, observacion_admin = ?, actualizado_en = NOW()
       WHERE id_solicitud = ? AND estado = 1`,
      [obs || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'La solicitud no existe o ya fue procesada anteriormente.' });
    }

    return res.json({ ok: true, msg: 'Solicitud de teletrabajo RECHAZADA.' });
  } catch (error) {
    console.error('Error al rechazar teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error interno al rechazar la solicitud.' });
  }
});

/* ==========================================================================
   FASE 2 DE APROBACIÓN: AUDITORÍA DE JORNADAS Y BITÁCORAS OBSERVADAS
   ========================================================================== */

/**
 * GET /api/admin/teletrabajo/pendientes-auditoria
 * Lista todas las jornadas de teletrabajo que están en estado 'OBSERVADO' con su bitácora
 */
router.get('/api/admin/teletrabajo/pendientes-auditoria', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [jornadas] = await db.query(`
      SELECT 
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
        
        -- Datos de la solicitud original de teletrabajo
        st.direccion_remota,
        st.motivo AS motivo_solicitud,
        
        -- Bitácora de trabajo y comprobante
        r.id_reporte,
        r.tarea,
        r.comprobante,
        r.observacion AS reporte_observacion,
        
        -- Horas trabajadas calculadas en HH:MM
        IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
           TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i'),
           '00:00'
        ) AS horas_calculadas
      FROM asistencias a
      INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
      LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
      LEFT JOIN solicitudes_teletrabajo st ON st.id_solicitud = ag.id_solicitud_teletrabajo
      LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
      WHERE a.estado = 'OBSERVADO' AND (ag.modalidad = 'TELETRABAJO' OR ag.id_geo IS NOT NULL)
      ORDER BY a.fecha DESC, a.hora_entrada DESC
    `);

    return res.json({ ok: true, jornadas: jornadas || [] });
  } catch (error) {
    console.error('Error al obtener auditoría de teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error al consultar jornadas observadas.' });
  }
});

/**
 * POST /api/admin/teletrabajo/jornada/:id/approve
 * Aprueba definitivamente una jornada de teletrabajo observada -> pasa a 'PRESENTE'
 */
router.post('/api/admin/teletrabajo/jornada/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const obs = String(req.body?.obs || '').trim();

    if (!id) return res.status(400).json({ ok: false, msg: 'ID de asistencia inválido' });

    const [result] = await db.query(
      `UPDATE asistencias
       SET estado = 'PRESENTE', 
           observacion = ?,
           actualizado_en = NOW()
       WHERE id_asistencia = ? AND estado = 'OBSERVADO'`,
      [obs ? `Teletrabajo Aprobado | Obs Admin: ${obs}` : 'Teletrabajo Aprobado por Administrador', id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'La jornada no está en estado OBSERVADO o no existe.' });
    }

    return res.json({ ok: true, msg: 'Jornada de teletrabajo y bitácora APROBADAS con éxito. Las horas se han sumado al total acumulado.' });
  } catch (error) {
    console.error('Error al aprobar jornada de teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error interno al aprobar jornada.' });
  }
});

/**
 * POST /api/admin/teletrabajo/jornada/:id/reject
 * Rechaza una jornada de teletrabajo observada -> pasa a 'RECHAZADO'
 */
router.post('/api/admin/teletrabajo/jornada/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const obs = String(req.body?.obs || '').trim();

    if (!id) return res.status(400).json({ ok: false, msg: 'ID de asistencia inválido' });

    const [result] = await db.query(
      `UPDATE asistencias
       SET estado = 'RECHAZADO', 
           observacion = ?,
           actualizado_en = NOW()
       WHERE id_asistencia = ? AND estado = 'OBSERVADO'`,
      [obs ? `Teletrabajo Rechazado | Motivo: ${obs}` : 'Teletrabajo Rechazado por Administrador', id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ ok: false, msg: 'La jornada no está en estado OBSERVADO o no existe.' });
    }

    return res.json({ ok: true, msg: 'Jornada de teletrabajo RECHAZADA.' });
  } catch (error) {
    console.error('Error al rechazar jornada de teletrabajo:', error);
    return res.status(500).json({ ok: false, msg: 'Error interno al rechazar jornada.' });
  }
});

module.exports = router;
