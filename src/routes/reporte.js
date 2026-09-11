const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');

// ===== Multer (comprobantes) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(process.cwd(), 'public', 'uploads', 'comprobantes'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const name = `comp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const m = (file.mimetype || '').toLowerCase();
  if (['image/png', 'image/jpg', 'image/jpeg'].includes(m)) return cb(null, true);
  cb(new Error('Solo se permiten imágenes PNG o JPG/JPEG'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

/* ==========================================================================
   GET: VISTA PRINCIPAL DEL USUARIO (LISTADO DE JORNADAS Y BITÁCORAS)
   ========================================================================== */
router.get('/usuario/reporte', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    // 1. Datos del usuario autenticado
    const [users] = await db.query(
      'SELECT id_usuario, nombre, CI, rol FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [userId]
    );

    if (users.length === 0) return res.status(404).send('Usuario no encontrado');
    const userDB = users[0];

    // 2. Total acumulado de horas OFICIALES / APROBADAS (Excluye OBSERVADO y ANULADO)
    const [totals] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha, hora_entrada),
            TIMESTAMP(fecha, hora_salida)
          )
        ), 0
      ) AS total_segundos
      FROM asistencias
      WHERE id_usuario = ?
        AND estado NOT IN ('ANULADO', 'OBSERVADO', 'RECHAZADO')
        AND hora_entrada IS NOT NULL
        AND hora_salida IS NOT NULL
    `, [userId]);

    const [totalsHE] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha_solicitada, hora_inicio),
            TIMESTAMP(fecha_solicitada, hora_fin)
          )
        ), 0
      ) AS total_segundos_he
      FROM notificaciones
      WHERE id_usuario = ?
        AND estado = 2
        AND hora_inicio IS NOT NULL
        AND hora_fin IS NOT NULL
    `, [userId]);

    const totalSegundos = (totals[0]?.total_segundos || 0) + (totalsHE[0]?.total_segundos_he || 0);
    const total_acumulada = formatSecondsToHHMMSS(totalSegundos);

    // 2.1. Total de horas EN OBSERVACIÓN (Teletrabajo pendiente de revisión de bitácora)
    const [totalsObs] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha, hora_entrada),
            TIMESTAMP(fecha, hora_salida)
          )
        ), 0
      ) AS total_segundos_obs
      FROM asistencias
      WHERE id_usuario = ?
        AND estado = 'OBSERVADO'
        AND hora_entrada IS NOT NULL
        AND hora_salida IS NOT NULL
    `, [userId]);

    const total_observadas = formatSecondsToHHMMSS(totalsObs[0]?.total_segundos_obs || 0);

    // 2.2. Verificar si el usuario tiene permiso de teletrabajo aprobado para hoy
    const [teletrabajoAprobadoRows] = await db.query(`
      SELECT 
        id_solicitud, 
        direccion_remota, 
        TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio, 
        TIME_FORMAT(hora_fin, '%H:%i') AS hora_fin,
        motivo
      FROM solicitudes_teletrabajo
      WHERE id_usuario = ? AND fecha_solicitada = CURDATE() AND estado = 2
      LIMIT 1
    `, [userId]);
    const teletrabajoHoy = teletrabajoAprobadoRows.length > 0 ? teletrabajoAprobadoRows[0] : null;

    // 2.3. Consultar la jornada de hoy (entrada, salida, lugar, timestamps crudos, modalidad)
    const [jornadaHoyRows] = await db.query(`
      SELECT 
        a.id_asistencia, 
        COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
        a.estado AS asistencia_estado,
        l.nombre AS lugar_nombre,
        TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
        TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
        a.hora_entrada AS hora_entrada_raw,
        a.hora_salida AS hora_salida_raw,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha_raw,
        TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)) AS duracion_segundos
      FROM asistencias a
      LEFT JOIN asistencias_geo ag ON a.id_asistencia = ag.id_asistencia
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      WHERE a.id_usuario = ? 
        AND a.fecha = CURDATE() 
        AND a.estado != 'ANULADO'
      ORDER BY a.id_asistencia DESC
      LIMIT 1
    `, [userId]);

    let jornadaHoy = null;
    if (jornadaHoyRows.length > 0) {
      const row = jornadaHoyRows[0];
      let estado = 'SIN_JORNADA';
      if (row.hora_entrada && !row.hora_salida) {
        estado = 'EN_CURSO';
      } else if (row.hora_entrada && row.hora_salida) {
        estado = 'COMPLETADA';
      }
      jornadaHoy = {
        ...row,
        estado
      };
    } else {
      jornadaHoy = {
        estado: 'SIN_JORNADA',
        modalidad: teletrabajoHoy ? 'TELETRABAJO' : 'PRESENCIAL'
      };
    }

    const jornadaActiva = (jornadaHoy && jornadaHoy.estado === 'EN_CURSO') ? jornadaHoy : null;

    // 2.4. Consultar si hay una sesión de Horas Extras en curso (estado = 0)
    const [heActivaRows] = await db.query(`
      SELECT 
        id_notificacion,
        DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada,
        TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio,
        TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio_corta,
        fecha_solicitada AS fecha_raw,
        hora_inicio AS hora_inicio_raw
      FROM notificaciones
      WHERE id_usuario = ? AND estado = 0
      ORDER BY id_notificacion DESC
      LIMIT 1
    `, [userId]);
    const horaExtraActiva = heActivaRows.length > 0 ? heActivaRows[0] : null;

    // 3. JORNADAS UNIFICADAS: Asistencias ordinarias + Teletrabajo + Horas Extras Aprobadas (Sin UNION para evitar conflicto de collations)
    const [asistenciasRows] = await db.query(`
      SELECT 
        CAST(a.id_asistencia AS CHAR) AS id_asistencia,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        a.estado AS asistencia_estado,
        COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
        l.nombre AS lugar_nombre,
        l.tipo AS lugar_tipo,
        TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada_f,
        TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida_f,
        a.hora_entrada,
        a.hora_salida,
        r.id_reporte,
        r.tarea,
        r.comprobante,
        COALESCE(r.observacion, a.observacion) AS observacion
      FROM asistencias a
      LEFT JOIN asistencias_geo ag ON a.id_asistencia = ag.id_asistencia
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      LEFT JOIN reportes r ON a.id_asistencia = r.id_asistencia
      WHERE a.id_usuario = ?
        AND a.estado != 'ANULADO'
    `, [userId]);

    const [heRows] = await db.query(`
      SELECT
        CONCAT('he_', n.id_notificacion) AS id_asistencia,
        DATE_FORMAT(n.fecha_solicitada, '%Y-%m-%d') AS fecha,
        'FINALIZADO' AS asistencia_estado,
        'HORA_EXTRA' AS modalidad,
        'Horas Extras' AS lugar_nombre,
        'HORA_EXTRA' AS lugar_tipo,
        TIME_FORMAT(n.hora_inicio, '%H:%i') AS hora_entrada_f,
        TIME_FORMAT(n.hora_fin, '%H:%i') AS hora_salida_f,
        n.hora_inicio AS hora_entrada,
        n.hora_fin AS hora_salida,
        NULL AS id_reporte,
        n.tarea,
        n.comprobante,
        n.observacion_admin AS observacion
      FROM notificaciones n
      WHERE n.id_usuario = ?
        AND n.estado = 2
    `, [userId]);

    const jornadas = [...asistenciasRows, ...heRows].sort((a, b) => {
      const cmpDate = (b.fecha || '').localeCompare(a.fecha || '');
      if (cmpDate !== 0) return cmpDate;
      return String(b.hora_entrada || '').localeCompare(String(a.hora_entrada || ''));
    });
    const jornadasProcesadas = jornadas.map(j => ({
      ...j,
      hora_entrada_vis: j.hora_entrada_f || '-',
      hora_salida_vis: j.hora_salida_f || '-',
      horas_dia: calcularHorasTranscurridas(j)
    }));

    const user = {
      id: userDB.id_usuario,
      nombre: userDB.nombre,
      ci: userDB.CI,
      rol: userDB.rol
    };

    res.render('usuario/reporte', {
      user,
      total_acumulada,
      total_observadas,
      teletrabajoHoy,
      jornadaActiva,
      jornadaHoy,
      horaExtraActiva,
      jornadas: jornadasProcesadas,
      cloudinaryCloudName: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME || 'sjgf9nkd',
      cloudinaryUploadPreset: process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET || process.env.CLOUDINARY_UPLOAD_PRESET || 'pasantes_preset'
    });

  } catch (e) {
    console.error(e);
    res.status(500).send('Error consultando la base de datos');
  }
});

function calcularHorasTranscurridas(j) {
  const entradaStr = j.hora_entrada;
  const salidaStr = j.hora_salida;

  // Si no hay entrada registrada o no hay salida aún
  if (!entradaStr || !salidaStr) {
    return '0 hrs';
  }

  try {
    const fechaBase = j.fecha || '1970-01-01';
    const inicio = new Date(`${fechaBase}T${entradaStr}`);
    const fin = new Date(`${fechaBase}T${salidaStr}`);

    // Si la hora de salida es menor a la de entrada (ejemplo: turno nocturno)
    if (fin < inicio) {
      fin.setDate(fin.getDate() + 1);
    }

    const diffMs = fin - inicio;
    if (isNaN(diffMs) || diffMs < 0) return '0 hrs';

    const totalMinutos = Math.floor(diffMs / (1000 * 60));
    const horas = Math.floor(totalMinutos / 60);
    const minutos = totalMinutos % 60;

    // Retorna formateado, por ejemplo: "8h 30m" o "8 hrs"
    if (minutos === 0) {
      return `${horas} hrs`;
    }
    return `${horas}h ${minutos}m`;
  } catch (err) {
    return '0 hrs';
  }
}

function formatSecondsToHHMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ==========================================================================
   ENDPOINTS API PARA BITÁCORAS / REPORTES DE TRABAJO
   ========================================================================== */

// Helper: obtener reporte de una asistencia específica
async function getReportePorAsistencia(idAsistencia, userId) {
  const [rows] = await db.query(`
    SELECT 
      id_reporte, 
      id_usuario, 
      id_asistencia,
      DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,
      tarea, 
      comprobante, 
      observacion
    FROM reportes
    WHERE id_asistencia = ? AND id_usuario = ?
    LIMIT 1
  `, [idAsistencia, userId]);

  return rows[0] || null;
}

// Helper middleware para manejar opcionalmente multipart o json
const handleUploadOptional = (req, res, next) => {
  if (req.is('multipart/form-data')) {
    upload.single('comprobante')(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  } else {
    next();
  }
};

// POST: Registrar o Actualizar Bitácora (Tarea + Comprobante Cloudinary/Local)
router.post('/reportes/guardar', requireAuth, handleUploadOptional, async (req, res) => {
  try {
    const userId = req.session.user.id;
    let { id_asistencia, tarea, comprobante } = req.body;
    tarea = String(tarea || '').trim().slice(0, 350);

    if (!id_asistencia || !tarea) {
      return res.status(400).json({ ok: false, error: 'Debe seleccionar una asistencia y describir la tarea.' });
    }

    // Ruta de la imagen cargada por Multer o enviada desde Cloudinary
    const publicPath = req.file ? '/uploads/comprobantes/' + req.file.filename : null;
    const comprobanteUrl = (comprobante && typeof comprobante === 'string' && comprobante.trim() !== '') 
      ? comprobante.trim() 
      : publicPath;

    // Verificar si ya existe un reporte registrado para esta asistencia
    const [reportes] = await db.query(
      'SELECT id_reporte, comprobante FROM reportes WHERE id_asistencia = ? AND id_usuario = ? LIMIT 1',
      [id_asistencia, userId]
    );

    const reporteExistente = reportes.length > 0 ? reportes[0] : null;

    if (reporteExistente) {
      // Si subió nueva imagen usa comprobanteUrl, de lo contrario conserva la imagen previa
      const imgFinal = comprobanteUrl !== null ? comprobanteUrl : reporteExistente.comprobante;

      await db.query(`
        UPDATE reportes
        SET tarea = ?, 
            comprobante = ?, 
            actualizado_en = CURRENT_TIMESTAMP
        WHERE id_reporte = ? AND id_usuario = ?
      `, [tarea, imgFinal, reporteExistente.id_reporte, userId]);

      return res.json({ ok: true, msg: 'Bitácora actualizada con éxito', comprobante: imgFinal });
    } else {
      // Obtener la fecha correspondiente a la asistencia seleccionada
      const [[asistencia]] = await db.query(
        'SELECT fecha FROM asistencias WHERE id_asistencia = ? AND id_usuario = ?',
        [id_asistencia, userId]
      );

      if (!asistencia) {
        return res.status(404).json({ ok: false, error: 'Asistencia no encontrada' });
      }

      // Inserción respetando el esquema
      await db.query(`
        INSERT INTO reportes (id_usuario, id_asistencia, fecha, tarea, comprobante)
        VALUES (?, ?, ?, ?, ?)
      `, [userId, id_asistencia, asistencia.fecha, tarea, comprobanteUrl]);

      return res.json({ ok: true, msg: 'Bitácora creada con éxito', comprobante: comprobanteUrl });
    }

  } catch (err) {
    console.error('Error al guardar reporte:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la bitácora de trabajo' });
  }
});


// Helper: Obtener Fecha y Hora de Bolivia (La Paz, UTC-4)
function getBoliviaDateTime() {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('sv-SE', { timeZone: 'America/La_Paz' }); // YYYY-MM-DD
  const hora = ahora.toLocaleTimeString('en-GB', { timeZone: 'America/La_Paz' }); // HH:MM:SS
  return { fecha, hora, ahora };
}

/* ==========================================================================
   HORAS EXTRAS EN TIEMPO REAL: INICIAR, CANCELAR Y FINALIZAR (ZONA HORARIA BOLIVIA)
   ========================================================================== */

// 1. INICIAR SESIÓN DE HORAS EXTRAS (Cronómetro activo con hora de Bolivia)
router.post('/api/horas-extras/iniciar', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;

    // Verificar si ya tiene una sesión activa
    const [existentes] = await db.query(
      `SELECT id_notificacion, DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada, TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio 
       FROM notificaciones 
       WHERE id_usuario = ? AND estado = 0 
       ORDER BY id_notificacion DESC LIMIT 1`,
      [userId]
    );

    if (existentes.length > 0) {
      return res.json({
        ok: true,
        msg: 'Ya tienes una sesión de horas extras en curso.',
        horaExtra: existentes[0]
      });
    }

    const { fecha: fechaBolivia, hora: horaBolivia } = getBoliviaDateTime();

    const [result] = await db.query(
      `INSERT INTO notificaciones (id_usuario, fecha_solicitada, hora_inicio, estado)
       VALUES (?, ?, ?, 0)`,
      [userId, fechaBolivia, horaBolivia]
    );

    const [nuevo] = await db.query(
      `SELECT id_notificacion, DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada, TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio 
       FROM notificaciones WHERE id_notificacion = ?`,
      [result.insertId]
    );

    res.json({
      ok: true,
      msg: 'Sesión de horas extras iniciada con éxito. El cronómetro está corriendo.',
      horaExtra: nuevo[0]
    });
  } catch (err) {
    console.error('Error al iniciar horas extras:', err);
    res.status(500).json({ ok: false, msg: 'Error al iniciar la sesión de horas extras' });
  }
});

// 2. CANCELAR SESIÓN DE HORAS EXTRAS EN CURSO
router.post('/api/horas-extras/cancelar', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;
    const { id_notificacion } = req.body || {};

    if (id_notificacion) {
      await db.query('DELETE FROM notificaciones WHERE id_usuario = ? AND id_notificacion = ? AND estado = 0', [userId, id_notificacion]);
    } else {
      await db.query('DELETE FROM notificaciones WHERE id_usuario = ? AND estado = 0', [userId]);
    }

    res.json({ ok: true, msg: 'Sesión de horas extras descartada exitosamente.' });
  } catch (err) {
    console.error('Error al cancelar horas extras:', err);
    res.status(500).json({ ok: false, msg: 'Error al cancelar la sesión de horas extras' });
  }
});

// 3. FINALIZAR HORAS EXTRAS (REGISTRAR INFORME + FOTO OBLIGATORIA CON HORA DE BOLIVIA)
router.post('/api/horas-extras/finalizar', requireAuth, handleUploadOptional, async (req, res) => {
  try {
    const userId = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;
    const { id_notificacion, tarea, motivo, comprobante } = req.body;

    const tareaFinal = String(tarea || motivo || '').trim();
    if (!tareaFinal || tareaFinal.length < 5) {
      return res.status(400).json({ ok: false, msg: 'Debes ingresar un informe de actividades detallado de lo que realizaste (mínimo 5 caracteres).' });
    }

    // Comprobante / Foto obligatoria
    const publicPath = req.file ? '/uploads/comprobantes/' + req.file.filename : null;
    const comprobanteFinal = (comprobante && typeof comprobante === 'string' && comprobante.trim() !== '') 
      ? comprobante.trim() 
      : publicPath;

    if (!comprobanteFinal) {
      return res.status(400).json({ ok: false, msg: 'Es obligatorio adjuntar una fotografía o captura de evidencia del trabajo realizado.' });
    }

    // Buscar la sesión activa en curso
    let querySesion = `SELECT id_notificacion, DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada, TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio FROM notificaciones WHERE id_usuario = ? AND estado = 0`;
    let paramsSesion = [userId];
    if (id_notificacion) {
      querySesion += ' AND id_notificacion = ?';
      paramsSesion.push(id_notificacion);
    }
    querySesion += ' ORDER BY id_notificacion DESC LIMIT 1';

    const [sesiones] = await db.query(querySesion, paramsSesion);
    if (!sesiones.length) {
      return res.status(400).json({ 
        ok: false, 
        msg: 'No se encontró ninguna sesión de horas extras activa. Debes presionar "Iniciar Horas Extras" antes de poder finalizar.' 
      });
    }

    const s = sesiones[0];
    const { fecha: fechaFinBolivia, hora: horaFinBolivia } = getBoliviaDateTime();

    // Calcular duración exacta
    const inicioDate = new Date(`${s.fecha_solicitada}T${s.hora_inicio}`);
    const finDate = new Date(`${fechaFinBolivia}T${horaFinBolivia}`);
    const diffSeg = Math.max(0, Math.floor((finDate.getTime() - inicioDate.getTime()) / 1000));
    const horasCantidad = Math.round((diffSeg / 3600) * 100) / 100;

    // Actualizar con hora_fin de Bolivia, estado = 1 (En Revisión del Administrador)
    await db.query(`
      UPDATE notificaciones
      SET hora_fin = ?,
          horas_cantidad = ?,
          tarea = ?,
          motivo = ?,
          comprobante = ?,
          estado = 1,
          actualizado_en = NOW()
      WHERE id_notificacion = ?
    `, [horaFinBolivia, horasCantidad, tareaFinal, tareaFinal, comprobanteFinal, s.id_notificacion]);

    res.json({
      ok: true,
      msg: '¡Horas extras finalizadas con éxito! Tu informe y fotografía de evidencia fueron enviados a revisión y evaluación del administrador.'
    });
  } catch (err) {
    console.error('Error al finalizar horas extras:', err);
    res.status(500).json({ ok: false, msg: 'Error al finalizar las horas extras' });
  }
});

// Endpoint de compatibilidad
router.post('/api/notificaciones', requireAuth, handleUploadOptional, async (req, res) => {
  return res.status(400).json({
    ok: false,
    msg: 'Para registrar horas extras debes usar el botón "Iniciar Horas Extras" y luego "Finalizar Horas Extras".'
  });
});

/* ==========================================================================
   EXPORTAR ASISTENCIA Y REPORTES A EXCEL
   ========================================================================== */
router.get('/reportes/export', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [urows] = await db.query('SELECT id_usuario, nombre FROM usuarios WHERE id_usuario = ? LIMIT 1', [userId]);
    if (!urows || urows.length === 0) return res.status(404).send('Usuario no encontrado');
    const usuario = urows[0];

    // Consulta unificada uniendo asistencias con reportes y horas extras (Sin UNION para evitar conflicto de collations)
    const [asistenciasReports] = await db.query(`
      SELECT
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        l.nombre AS lugar,
        TIME_FORMAT(a.hora_entrada, '%H:%i:%s') AS hora_entrada,
        TIME_FORMAT(a.hora_salida, '%H:%i:%s') AS hora_salida,
        IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL, 
           TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i:%s'), 
           '00:00:00') AS horas_trabajadas,
        r.tarea, 
        COALESCE(r.observacion, a.observacion) AS observacion
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      LEFT JOIN reportes r ON a.id_asistencia = r.id_asistencia
      WHERE a.id_usuario = ?
        AND a.estado != 'ANULADO'
    `, [userId]);

    const [heReports] = await db.query(`
      SELECT
        DATE_FORMAT(n.fecha_solicitada, '%Y-%m-%d') AS fecha,
        '⚡ Horas Extras (Aprobadas)' AS lugar,
        TIME_FORMAT(n.hora_inicio, '%H:%i:%s') AS hora_entrada,
        TIME_FORMAT(n.hora_fin, '%H:%i:%s') AS hora_salida,
        IF(n.hora_fin IS NOT NULL AND n.hora_inicio IS NOT NULL,
           TIME_FORMAT(TIMEDIFF(n.hora_fin, n.hora_inicio), '%H:%i:%s'),
           '00:00:00') AS horas_trabajadas,
        n.tarea,
        n.observacion_admin AS observacion
      FROM notificaciones n
      WHERE n.id_usuario = ?
        AND n.estado = 2
    `, [userId]);

    const reports = [...asistenciasReports, ...heReports].sort((a, b) => {
      const cmpDate = (b.fecha || '').localeCompare(a.fecha || '');
      if (cmpDate !== 0) return cmpDate;
      return String(b.hora_entrada || '').localeCompare(String(a.hora_entrada || ''));
    });

    const [totals] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha, hora_entrada),
            TIMESTAMP(fecha, hora_salida)
          )
        ), 0
      ) AS total_segundos
      FROM asistencias
      WHERE id_usuario = ? 
        AND estado NOT IN ('ANULADO', 'OBSERVADO', 'RECHAZADO')
        AND hora_entrada IS NOT NULL
        AND hora_salida IS NOT NULL
    `, [userId]);

    const [totalsHE] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha_solicitada, hora_inicio),
            TIMESTAMP(fecha_solicitada, hora_fin)
          )
        ), 0
      ) AS total_segundos_he
      FROM notificaciones
      WHERE id_usuario = ?
        AND estado = 2
        AND hora_inicio IS NOT NULL
        AND hora_fin IS NOT NULL
    `, [userId]);

    const totalSegundos = (totals[0]?.total_segundos || 0) + (totalsHE[0]?.total_segundos_he || 0);
    const totalAcum = formatSecondsToHHMMSS(totalSegundos);

    const toExcelDate = (ymd) => {
      if (!ymd) return null;
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Asistencia y Bitácora');

    ws.mergeCells('A1:G1');
    ws.getCell('A1').value = `Reporte de Pasante / Estudiante: ${usuario.nombre}`;
    ws.getCell('A1').font = { bold: true, size: 14 };

    ws.mergeCells('A2:G2');
    ws.getCell('A2').value = `Exportado el: ${new Date().toLocaleString()}  •  Total Horas Acumuladas: ${totalAcum}`;
    ws.getCell('A2').font = { italic: true, size: 11 };

    ws.addRow([]);
    ws.addRow(['Fecha', 'Lugar / Obra', 'Hora Entrada', 'Hora Salida', 'Horas Turno', 'Tarea (Descripción)', 'Observaciones']);

    const headerRow = ws.getRow(4);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });

    ws.columns = [
      { key: 'fecha', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
      { key: 'lugar', width: 20 },
      { key: 'hora_entrada', width: 12 },
      { key: 'hora_salida', width: 12 },
      { key: 'horas_trabajadas', width: 14 },
      { key: 'tarea', width: 40 },
      { key: 'observacion', width: 35 }
    ];

    if (!reports || reports.length === 0) {
      ws.addRow(['Sin registros', null, null, null, null, null, null]);
    } else {
      for (const r of reports) {
        ws.addRow({
          fecha: toExcelDate(r.fecha),
          lugar: r.lugar || 'N/A',
          hora_entrada: r.hora_entrada || '-',
          hora_salida: r.hora_salida || '-',
          horas_trabajadas: r.horas_trabajadas,
          tarea: r.tarea || 'Sin bitácora',
          observacion: r.observacion || ''
        });
      }
    }

    const startDataRow = headerRow.number + 1;
    for (let i = startDataRow; i <= ws.lastRow.number; i++) {
      ws.getRow(i).eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    }

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    const safeName = String(usuario.nombre || 'usuario').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const ymd = new Date().toISOString().slice(0, 10);
    const filename = `reportes_${safeName}_${ymd}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo generar el Excel.');
  }
});

module.exports = router;