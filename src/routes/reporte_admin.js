const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const ExcelJS = require('exceljs');

// Helper para formatear segundos a HH:MM:SS sin límite de 838 horas
function formatSecondsToHHMMSS(totalSecs) {
  const s = parseInt(totalSecs, 10);
  if (!s || isNaN(s) || s <= 0) return '00:00:00';
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Helper para formatear segundos a HH:MM (duración del día)
function formatSecondsToHHMM(totalSecs) {
  const s = parseInt(totalSecs, 10);
  if (isNaN(s) || s < 0) return '00:00';
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}`;
}

// Middleware de autorización para el rol de administrador
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.rol !== 1) return res.status(403).send('No autorizado');
  next();
}

/* ==========================================================================
   VISTA: RENDERIZAR PANEL ADMINISTRATIVO DE REPORTES
   ========================================================================== */
router.get('/admin/reportes', requireAdmin, async (req, res) => {
  try {
    // 1. Consultar usuarios para el autocompletado y filtros (con su carrera asociada)
    const [usuarios] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.CI, u.universidad, u.id_carrera, c.nombre AS carrera_nombre
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       ORDER BY u.nombre ASC`
    );

    // 2. Consultar obras y lugares para el filtro
    const [lugares] = await db.query(
      'SELECT id_lugar, nombre, tipo FROM lugares ORDER BY nombre ASC'
    );

    // 3. Consultar lista de carreras desde la tabla carreras
    const [carreras] = await db.query(
      `SELECT id_carrera, nombre, siglas FROM carreras ORDER BY nombre ASC`
    );

    // 4. Pasar 'usuarios', 'lugares' y 'carreras' a la vista
    res.render('reporte_admin', {
      user: req.session.user,
      usuarios: usuarios || [],
      lugares: lugares || [],
      carreras: carreras || []
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error al cargar la vista de reportes.');
  }
});

/* ==========================================================================
   API: LISTAR JORNADAS Y BITÁCORAS (PAGINADO Y FILTRADO)
   ========================================================================== */
router.get('/api/admin/reportes', requireAdmin, async (req, res) => {
  try {
    const id_carrera = req.query.id_carrera ? parseInt(req.query.id_carrera, 10) : (req.query.carrera ? parseInt(req.query.carrera, 10) || null : null);
    const estado_duracion = (req.query.estado_duracion || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fechasRaw = (req.query.fechas || req.query.fecha || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    let size = Math.max(parseInt(req.query.size || '25', 10), 1);
    size = Math.min(size, 200);

    const offset = (page - 1) * size;
    const where = ["a.estado != 'ANULADO'"];
    const params = [];

    if (id_carrera) {
      where.push('u.id_carrera = ?');
      params.push(id_carrera);
    }
    if (estado_duracion === 'FINALIZADO') {
      where.push('a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL');
    } else if (estado_duracion === 'EN_CURSO') {
      where.push('a.hora_salida IS NULL AND a.fecha = CURDATE()');
    } else if (estado_duracion === 'OBSERVADO') {
      where.push('a.hora_salida IS NULL AND a.fecha < CURDATE()');
    }

    if (id_usuario) {
      where.push('a.id_usuario = ?');
      params.push(id_usuario);
    } else if (nombre) {
      where.push('u.nombre LIKE ?');
      params.push(`%${nombre}%`);
    }
    if (id_lugar) {
      where.push('a.id_lugar = ?');
      params.push(id_lugar);
    }
    if (fechasRaw) {
      if (fechasRaw.includes(' to ') || fechasRaw.includes(' a ')) {
        const parts = fechasRaw.split(/\s+(?:to|a)\s+/);
        if (parts.length === 2 && parts[0] && parts[1]) {
          where.push('a.fecha BETWEEN ? AND ?');
          params.push(parts[0].trim(), parts[1].trim());
        } else if (parts[0]) {
          where.push('a.fecha = ?');
          params.push(parts[0].trim());
        }
      } else {
        const dateList = fechasRaw.split(/[,;\s]+/).map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (dateList.length === 1) {
          where.push('a.fecha = ?');
          params.push(dateList[0]);
        } else if (dateList.length > 1) {
          where.push(`a.fecha IN (${dateList.map(() => '?').join(', ')})`);
          params.push(...dateList);
        }
      }
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Total de registros coincidentes
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Total de horas acumuladas calculadas en segundos para el filtro actual
    const [totalsRows] = await db.query(
      `SELECT COALESCE(
         SUM(
           TIMESTAMPDIFF(
             SECOND,
             TIMESTAMP(a.fecha, a.hora_entrada),
             TIMESTAMP(a.fecha, a.hora_salida)
           )
         ), 0
       ) AS total_segundos
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL`,
      params
    );

    const totalSegundos = totalsRows[0]?.total_segundos || 0;
    const totalAcumulada = formatSecondsToHHMMSS(totalSegundos);

    // Consulta de información del usuario si está seleccionado
    let usuarioInfo = null;
    if (id_usuario) {
      const [uRows] = await db.query(
        `SELECT u.id_usuario, u.nombre, u.CI, u.universidad, u.id_carrera, COALESCE(c.nombre, '') AS carrera
         FROM usuarios u
         LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
         WHERE u.id_usuario = ? LIMIT 1`,
        [id_usuario]
      );
      if (uRows.length > 0) {
        usuarioInfo = uRows[0];
      }
    }

    // Consulta unificada: Asistencia + Lugar + Bitácora (Reporte)
    const [rows] = await db.query(
      `SELECT
         a.id_asistencia,
         u.id_usuario,
         u.nombre AS usuario_nombre,
         u.CI AS usuario_ci,
         DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
         l.nombre AS lugar_nombre,
         l.tipo AS lugar_tipo,
         
         -- Horarios de entrada y salida
         TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
         TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
         
         -- Duración en segundos si hay salida registrada
         IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
            TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
            NULL
         ) AS duracion_segundos,
         
         a.estado AS asistencia_estado,
         
         -- Campos provenientes de la bitácora
         r.id_reporte,
         r.tarea,
         r.comprobante,
         COALESCE(r.observacion, a.observacion) AS observacion
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
       LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
       ${whereSQL}
       ORDER BY a.fecha DESC, a.id_asistencia DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    // Formato de fecha actual YYYY-MM-DD para comparación estricta de cadenas
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const formattedRows = rows.map((r) => {
      const isPast = Boolean(r.fecha && r.fecha < todayStr);
      let estadoCalculado = 'FINALIZADO';
      let horasDiaText = '00:00';

      if (r.duracion_segundos != null) {
        estadoCalculado = 'FINALIZADO';
        horasDiaText = formatSecondsToHHMM(r.duracion_segundos);
      } else if (!r.hora_salida && isPast) {
        estadoCalculado = 'OBSERVADO';
        horasDiaText = 'Observación';
      } else if (!r.hora_salida) {
        estadoCalculado = 'EN_CURSO';
        horasDiaText = 'En curso';
      }

      return {
        ...r,
        estado_calculado: estadoCalculado,
        horas_dia: horasDiaText
      };
    });

    // Estadísticas adicionales dinámicas para el panel lateral derecho:
    let statsData = {};

    if (id_usuario || (usuarioInfo && usuarioInfo.id_usuario)) {
      const targetUserId = id_usuario || usuarioInfo.id_usuario;
      // 1. Estadísticas del usuario individual
      const [userStats] = await db.query(
        `SELECT
           COUNT(*) AS total_asistencias,
           SUM(IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL, 1, 0)) AS asistencias_finalizadas,
           SUM(IF(a.hora_salida IS NULL, 1, 0)) AS asistencias_en_curso,
           AVG(IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
                  TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
                  NULL
           )) AS promedio_segundos,
           SUM(IF(r.tarea IS NOT NULL AND TRIM(r.tarea) != '', 1, 0)) AS bitacoras_completadas,
           SUM(IF(r.comprobante IS NOT NULL AND TRIM(r.comprobante) != '', 1, 0)) AS comprobantes_subidos
         FROM asistencias a
         LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
         WHERE a.id_usuario = ? AND a.estado != 'ANULADO'`,
        [targetUserId]
      );

      // Desglose por obra / lugar
      const [lugaresDesglose] = await db.query(
        `SELECT
           COALESCE(l.nombre, 'Sin lugar asignado') AS lugar_nombre,
           l.tipo AS lugar_tipo,
           COUNT(a.id_asistencia) AS total_dias,
           COALESCE(SUM(
             IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
                TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
                0)
           ), 0) AS total_segundos
         FROM asistencias a
         LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
         WHERE a.id_usuario = ? AND a.estado != 'ANULADO'
         GROUP BY l.id_lugar, l.nombre, l.tipo
         ORDER BY total_segundos DESC`,
        [targetUserId]
      );

      const totalSeg = totalSegundos || 1;
      const formattedLugares = lugaresDesglose.map(l => ({
        ...l,
        horas_formateadas: formatSecondsToHHMM(l.total_segundos),
        horas_decimal: (l.total_segundos / 3600).toFixed(1),
        porcentaje: Math.min(100, Math.round((l.total_segundos / (totalSegundos || 1)) * 100))
      }));

      const promSeg = Math.round(userStats[0]?.promedio_segundos || 0);
      const promHoras = (promSeg / 3600).toFixed(1);

      statsData = {
        tipo: 'usuario',
        total_asistencias: userStats[0]?.total_asistencias || 0,
        asistencias_finalizadas: userStats[0]?.asistencias_finalizadas || 0,
        asistencias_en_curso: userStats[0]?.asistencias_en_curso || 0,
        promedio_horas_dia: `${promHoras} hrs/día`,
        bitacoras_completadas: userStats[0]?.bitacoras_completadas || 0,
        comprobantes_subidos: userStats[0]?.comprobantes_subidos || 0,
        lugares_desglose: formattedLugares
      };
    } else {
      // 2. Estadísticas globales (Ranking de horas por pasante y resumen general)
      const [topUsers] = await db.query(
        `SELECT
           u.id_usuario,
           u.nombre,
           u.CI,
           COALESCE(c.nombre, '') AS carrera,
           u.universidad,
           COUNT(a.id_asistencia) AS total_dias,
           COALESCE(
             SUM(
               IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
                  TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
                  0)
             ), 0
           ) AS total_segundos
         FROM usuarios u
         LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
         LEFT JOIN asistencias a ON a.id_usuario = u.id_usuario AND a.estado != 'ANULADO'
         WHERE u.rol = 0
         GROUP BY u.id_usuario, u.nombre, u.CI, c.nombre, u.universidad
         ORDER BY total_segundos DESC
         LIMIT 6`
      );

      const maxSegundos = topUsers.length > 0 && topUsers[0].total_segundos > 0 ? topUsers[0].total_segundos : 1;

      const formattedTop = topUsers.map((u, idx) => ({
        id_usuario: u.id_usuario,
        nombre: u.nombre,
        CI: u.CI,
        carrera: u.carrera,
        universidad: u.universidad,
        total_dias: u.total_dias,
        horas_formateadas: formatSecondsToHHMMSS(u.total_segundos),
        horas_decimal: (u.total_segundos / 3600).toFixed(1),
        porcentaje_relativo: Math.min(100, Math.round((u.total_segundos / maxSegundos) * 100)),
        ranking: idx + 1
      }));

      statsData = {
        tipo: 'global',
        top_usuarios: formattedTop,
        total_pasantes_ranking: topUsers.length
      };
    }

    // 3. Series temporales para gráficos interactivos (Horas por Semana y por Día de la Semana)
    const [semanasRows] = await db.query(
      `SELECT
         DATE_FORMAT(DATE_SUB(a.fecha, INTERVAL WEEKDAY(a.fecha) DAY), '%Y-%m-%d') AS semana_inicio,
         CONCAT('Sem ', DATE_FORMAT(a.fecha, '%v')) AS semana_label,
         ROUND(SUM(TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida))) / 3600, 1) AS horas,
         COUNT(a.id_asistencia) AS total_dias
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL
       GROUP BY semana_inicio, semana_label
       ORDER BY semana_inicio ASC
       LIMIT 15`,
      params
    );

    const diasNombresList = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const [diasSemanaRows] = await db.query(
      `SELECT
         WEEKDAY(a.fecha) AS dia_idx,
         ROUND(SUM(TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida))) / 3600, 1) AS total_horas,
         ROUND(AVG(TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida))) / 3600, 1) AS promedio_horas,
         COUNT(a.id_asistencia) AS total_asistencias
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL
       GROUP BY dia_idx
       ORDER BY dia_idx ASC`,
      params
    );

    const diasMap = {};
    diasSemanaRows.forEach(d => {
      diasMap[d.dia_idx] = d;
    });

    const seriesDias = [0, 1, 2, 3, 4, 5, 6].map(idx => ({
      dia_idx: idx,
      dia_nombre: diasNombresList[idx],
      total_horas: diasMap[idx] ? Number(diasMap[idx].total_horas) : 0,
      promedio_horas: diasMap[idx] ? Number(diasMap[idx].promedio_horas) : 0,
      total_asistencias: diasMap[idx] ? diasMap[idx].total_asistencias : 0
    }));

    statsData.series_semanal = semanasRows.map(s => ({
      semana_inicio: s.semana_inicio,
      semana_label: s.semana_label,
      horas: Number(s.horas || 0),
      total_dias: s.total_dias
    }));

    statsData.series_dias_semana = seriesDias;

    res.json({
      ok: true,
      data: formattedRows,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      total_acumulada: totalAcumulada,
      total_horas_decimal: (totalSegundos / 3600).toFixed(1),
      usuario_info: usuarioInfo,
      stats: statsData
    });
  } catch (e) {
    console.error('Error en /api/admin/reportes:', e);
    res.status(500).json({ ok: false, error: 'Error al consultar asistencias y reportes' });
  }
});

/* ==========================================================================
   API: ACTUALIZAR HORAS Y OBSERVACIÓN DEL ADMIN EN LA ASISTENCIA / BITÁCORA
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia', requireAdmin, async (req, res) => {
  try {
    const id_asistencia = parseInt(req.params.id_asistencia, 10);
    const { observacion, hora_entrada, hora_salida } = req.body || {};

    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    const valEntrada = hora_entrada && hora_entrada.trim() ? hora_entrada.trim() : null;
    const valSalida = hora_salida && hora_salida.trim() && hora_salida.trim() !== '-' ? hora_salida.trim() : null;
    const valObs = observacion && observacion.trim() ? observacion.trim() : null;

    // Actualizar horas y observación en la tabla asistencias activando candado EDITADO_ADMIN
    await db.query(
      `UPDATE asistencias 
       SET hora_entrada = ?, 
           hora_salida = ?, 
           observacion = ?,
           estado = 'EDITADO_ADMIN'
       WHERE id_asistencia = ?`,
      [valEntrada, valSalida, valObs, id_asistencia]
    );

    // Si existe bitácora vinculada, actualizarla también
    await db.query('UPDATE reportes SET observacion = ? WHERE id_asistencia = ?', [valObs, id_asistencia]);

    res.json({ ok: true, msg: 'Jornada y horas actualizadas correctamente' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error interno al actualizar la jornada' });
  }
});

/* ==========================================================================
   API: ANULAR / ELIMINAR ASISTENCIA (CANDADO ANULADO)
   ========================================================================== */
router.delete('/api/admin/reportes/:id_asistencia', requireAdmin, async (req, res) => {
  try {
    const id_asistencia = parseInt(req.params.id_asistencia, 10);
    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    await db.query("UPDATE asistencias SET estado = 'ANULADO' WHERE id_asistencia = ?", [id_asistencia]);

    res.json({ ok: true, msg: 'Jornada anulada correctamente' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error al anular la jornada' });
  }
});

/* ==========================================================================
   API: OBTENER HORARIO ASIGNADO DE UN USUARIO
   ========================================================================== */
router.get('/api/admin/usuarios/:id_usuario/horario', requireAdmin, async (req, res) => {
  try {
    const id_usuario = parseInt(req.params.id_usuario, 10);
    if (!id_usuario) return res.status(400).json({ ok: false, msg: 'ID de usuario no válido' });

    // 1. Datos del usuario
    const [uRows] = await db.query(
      'SELECT id_usuario, nombre, CI, universidad, carrera FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [id_usuario]
    );
    if (uRows.length === 0) {
      return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
    }
    const usuario = uRows[0];

    // 2. Horarios programados activos
    const [horarios] = await db.query(
      `SELECT
         id_horario,
         dia_semana,
         TIME_FORMAT(hora_entrada, '%H:%i') AS hora_entrada,
         TIME_FORMAT(hora_salida, '%H:%i') AS hora_salida,
         IF(hora_entrada IS NOT NULL AND hora_salida IS NOT NULL,
            TIMESTAMPDIFF(SECOND, TIMESTAMP(CURDATE(), hora_entrada), TIMESTAMP(CURDATE(), hora_salida)),
            0
         ) AS duracion_segundos,
         estado
       FROM horarios
       WHERE id_usuario = ? AND estado = 'ACTIVO'
       ORDER BY dia_semana ASC`,
      [id_usuario]
    );

    const diasNombres = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    let totalSegundosSemana = 0;

    const formattedHorarios = (horarios || []).map(h => {
      const durSecs = Math.max(0, h.duracion_segundos || 0);
      totalSegundosSemana += durSecs;
      const horasCalc = (durSecs / 3600).toFixed(1);
      return {
        ...h,
        dia_nombre: diasNombres[h.dia_semana] || `Día ${h.dia_semana}`,
        horas_dia: `${horasCalc} hrs`
      };
    });

    const totalHorasSemanales = (totalSegundosSemana / 3600).toFixed(1);

    res.json({
      ok: true,
      usuario,
      horarios: formattedHorarios,
      total_horas_semanales: `${totalHorasSemanales} hrs/sem`
    });
  } catch (e) {
    console.error('Error al obtener horario de usuario:', e);
    res.status(500).json({ ok: false, msg: 'Error al consultar horario' });
  }
});

/* ==========================================================================
   API: CALENDARIO DE ASISTENCIAS Y ACTIVIDADES DEL USUARIO
   ========================================================================== */
router.get('/api/admin/usuario/:id_usuario/calendario', requireAdmin, async (req, res) => {
  try {
    const id_usuario = parseInt(req.params.id_usuario, 10);
    if (!id_usuario) return res.status(400).json({ ok: false, msg: 'ID de usuario inválido' });

    // 1. Datos del usuario
    const [uRows] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.CI, u.universidad, u.id_carrera, COALESCE(c.nombre, '') AS carrera, COALESCE(c.siglas, '') AS siglas
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       WHERE u.id_usuario = ? LIMIT 1`,
      [id_usuario]
    );
    if (!uRows.length) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    // 2. Asistencias y bitácoras del usuario
    const [asistencias] = await db.query(
      `SELECT
         a.id_asistencia,
         DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
         TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
         TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
         l.nombre AS lugar_nombre,
         l.tipo AS lugar_tipo,
         IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
            TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
            NULL
         ) AS duracion_segundos,
         r.id_reporte,
         r.tarea,
         r.comprobante,
         COALESCE(r.observacion, a.observacion) AS observacion
       FROM asistencias a
       LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
       LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
       WHERE a.id_usuario = ? AND a.estado != 'ANULADO'
       ORDER BY a.fecha ASC, a.id_asistencia ASC`,
      [id_usuario]
    );

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const formatted = asistencias.map(a => {
      const isPast = Boolean(a.fecha && a.fecha < todayStr);
      let estado = 'FINALIZADO';
      let horasTxt = '00:00';

      if (a.duracion_segundos != null) {
        estado = 'FINALIZADO';
        horasTxt = formatSecondsToHHMM(a.duracion_segundos);
      } else if (!a.hora_salida && isPast) {
        estado = 'OBSERVADO';
        horasTxt = 'Observación';
      } else if (!a.hora_salida) {
        estado = 'EN_CURSO';
        horasTxt = 'En curso';
      }

      return {
        ...a,
        estado,
        horas_dia: horasTxt
      };
    });

    // 3. Horarios semanales asignados / registrados por el usuario
    const [horarios] = await db.query(
      `SELECT
         id_horario,
         dia_semana,
         TIME_FORMAT(hora_entrada, '%H:%i') AS hora_entrada,
         TIME_FORMAT(hora_salida, '%H:%i') AS hora_salida,
         estado
       FROM horarios
       WHERE id_usuario = ? AND estado = 'ACTIVO'
       ORDER BY dia_semana ASC`,
      [id_usuario]
    );

    res.json({
      ok: true,
      usuario: uRows[0],
      asistencias: formatted,
      horarios: horarios || []
    });
  } catch (err) {
    console.error('Error al obtener calendario del usuario:', err);
    res.status(500).json({ ok: false, msg: 'Error interno al consultar calendario' });
  }
});

/* ==========================================================================
   EXPORTAR CONSOLIDADO A EXCEL
   ========================================================================== */
router.get('/admin/reportes/export', requireAdmin, async (req, res) => {
  try {
    const id_carrera = req.query.id_carrera ? parseInt(req.query.id_carrera, 10) : (req.query.carrera ? parseInt(req.query.carrera, 10) || null : null);
    const estado_duracion = (req.query.estado_duracion || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fechasRaw = (req.query.fechas || req.query.fecha || '').trim();

    const where = ["a.estado != 'ANULADO'"];
    const params = [];
    if (id_carrera) {
      where.push('u.id_carrera = ?');
      params.push(id_carrera);
    }
    if (estado_duracion === 'FINALIZADO') {
      where.push('a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL');
    } else if (estado_duracion === 'EN_CURSO') {
      where.push('a.hora_salida IS NULL AND a.fecha = CURDATE()');
    } else if (estado_duracion === 'OBSERVADO') {
      where.push('a.hora_salida IS NULL AND a.fecha < CURDATE()');
    }
    if (id_usuario) {
      where.push('a.id_usuario = ?');
      params.push(id_usuario);
    } else if (nombre) {
      where.push('u.nombre LIKE ?');
      params.push(`%${nombre}%`);
    }
    if (id_lugar) {
      where.push('a.id_lugar = ?');
      params.push(id_lugar);
    }
    if (fechasRaw) {
      if (fechasRaw.includes(' to ') || fechasRaw.includes(' a ')) {
        const parts = fechasRaw.split(/\s+(?:to|a)\s+/);
        if (parts.length === 2 && parts[0] && parts[1]) {
          where.push('a.fecha BETWEEN ? AND ?');
          params.push(parts[0].trim(), parts[1].trim());
        } else if (parts[0]) {
          where.push('a.fecha = ?');
          params.push(parts[0].trim());
        }
      } else {
        const dateList = fechasRaw.split(/[,;\s]+/).map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (dateList.length === 1) {
          where.push('a.fecha = ?');
          params.push(dateList[0]);
        } else if (dateList.length > 1) {
          where.push(`a.fecha IN (${dateList.map(() => '?').join(', ')})`);
          params.push(...dateList);
        }
      }
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let userTitle = 'Reporte General de Asistencias y Bitácoras';
    let fileSuffix = 'general';
    if (id_usuario) {
      const [uRows] = await db.query('SELECT nombre, CI FROM usuarios WHERE id_usuario = ? LIMIT 1', [id_usuario]);
      if (uRows.length > 0) {
        userTitle = `Reporte de Asistencias y Bitácoras - ${uRows[0].nombre} (CI: ${uRows[0].CI})`;
        fileSuffix = `usuario_${uRows[0].CI}`;
      }
    } else if (id_carrera) {
      const [cRows] = await db.query('SELECT nombre FROM carreras WHERE id_carrera = ? LIMIT 1', [id_carrera]);
      const cNombre = cRows[0]?.nombre || `Carrera_${id_carrera}`;
      userTitle = `Reporte General - Carrera: ${cNombre}`;
      fileSuffix = `carrera_${cNombre.replace(/\s+/g, '_').toLowerCase()}`;
    } else if (id_lugar) {
      const [lRows] = await db.query('SELECT nombre FROM lugares WHERE id_lugar = ? LIMIT 1', [id_lugar]);
      if (lRows.length > 0) {
        userTitle = `Reporte General - Obra/Lugar: ${lRows[0].nombre}`;
        fileSuffix = `lugar_${lRows[0].nombre.replace(/\s+/g, '_').toLowerCase()}`;
      }
    } else if (nombre) {
      userTitle = `Reporte General - Filtro Nombre: ${nombre}`;
      fileSuffix = `usuario_${nombre.replace(/\s+/g, '_').toLowerCase()}`;
    }

    const [reports] = await db.query(
      `SELECT
         u.nombre, 
         u.CI,
         DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
         l.nombre AS lugar,
         TIME_FORMAT(a.hora_entrada, '%H:%i:%s') AS hora_entrada,
         TIME_FORMAT(a.hora_salida, '%H:%i:%s') AS hora_salida,
         IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
            TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
            NULL
         ) AS duracion_segundos,
         r.tarea, 
         COALESCE(r.observacion, a.observacion) AS observacion
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
       LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
       ${whereSQL}
       ORDER BY a.fecha DESC, a.id_asistencia DESC`,
      params
    );

    const [totalsRows] = await db.query(
      `SELECT COALESCE(
         SUM(
           TIMESTAMPDIFF(
             SECOND,
             TIMESTAMP(a.fecha, a.hora_entrada),
             TIMESTAMP(a.fecha, a.hora_salida)
           )
         ), 0
       ) AS total_segundos
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL`,
      params
    );

    const totalSegundos = totalsRows[0]?.total_segundos || 0;
    const totalAcum = formatSecondsToHHMMSS(totalSegundos);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reporte Asistencias');

    ws.mergeCells('A1:I1');
    ws.getCell('A1').value = userTitle;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0F5FA6' } };
    ws.getCell('A1').alignment = { vertical: 'middle' };

    ws.mergeCells('A2:I2');
    ws.getCell('A2').value = `Generado el: ${new Date().toLocaleString()}  •  Horas Totales Acumuladas: ${totalAcum}  •  Total Registros: ${reports.length}`;
    ws.getCell('A2').font = { italic: true, size: 11, color: { argb: 'FF475569' } };
    ws.getCell('A2').alignment = { vertical: 'middle' };

    ws.addRow([]);
    ws.addRow(['Usuario', 'CI', 'Fecha', 'Lugar / Obra', 'Hora Entrada', 'Hora Salida', 'Duración', 'Tarea (Bitácora)', 'Observación Admin']);

    const headerRow = ws.getRow(4);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF081426' }
    };

    ws.columns = [
      { key: 'nombre', width: 26 },
      { key: 'ci', width: 14 },
      { key: 'fecha', width: 14 },
      { key: 'lugar', width: 22 },
      { key: 'hora_entrada', width: 14 },
      { key: 'hora_salida', width: 14 },
      { key: 'horas_trabajadas', width: 14 },
      { key: 'tarea', width: 38 },
      { key: 'observacion', width: 32 }
    ];

    if (!reports.length) {
      ws.addRow(['Sin registros coincidentes', '', '', '', '', '', '', '', '']);
    } else {
      for (const r of reports) {
        ws.addRow({
          nombre: r.nombre,
          ci: r.CI,
          fecha: r.fecha,
          lugar: r.lugar || 'N/A',
          hora_entrada: r.hora_entrada || '-',
          hora_salida: r.hora_salida || '-',
          horas_trabajadas: r.duracion_segundos != null ? formatSecondsToHHMMSS(r.duracion_segundos) : 'En curso',
          tarea: r.tarea || 'Sin bitácora registrada',
          observacion: r.observacion || ''
        });
      }
    }

    const startRow = 5;
    for (let i = startRow; i <= ws.lastRow.number; i++) {
      const row = ws.getRow(i);
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    }

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    const filename = `reporte_admin_${fileSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('No se pudo generar el Excel.');
  }
});

module.exports = router;
