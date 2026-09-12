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
});// Helper para consultar Asistencias y Horas Extras Aprobadas de manera independiente (evita conflictos de colación SQL)
async function fetchCombinedRecords({ id_carrera, estado_duracion, id_usuario, id_lugar, nombre, fechasRaw, modalidad }) {
  const mod = (modalidad || '').trim().toUpperCase();

  // 1. Consulta de Asistencias Ordinarias + Teletrabajo
  let rowsA = [];
  if (mod !== 'HORA_EXTRA' && mod !== 'HORAS_EXTRAS') {
    const whereA = ["a.estado != 'ANULADO'"];
    const paramsA = [];

    if (id_carrera) {
      whereA.push('u.id_carrera = ?');
      paramsA.push(id_carrera);
    }
    if (id_usuario) {
      whereA.push('a.id_usuario = ?');
      paramsA.push(id_usuario);
    } else if (nombre) {
      whereA.push('u.nombre LIKE ?');
      paramsA.push(`%${nombre}%`);
    }
    if (id_lugar) {
      whereA.push('a.id_lugar = ?');
      paramsA.push(id_lugar);
    }
    if (estado_duracion === 'FINALIZADO') {
      whereA.push("a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL AND a.estado NOT IN ('ANULADO', 'OBSERVADO', 'RECHAZADO')");
    } else if (estado_duracion === 'EN_CURSO') {
      whereA.push("a.hora_salida IS NULL AND a.fecha = CURDATE() AND a.estado NOT IN ('ANULADO', 'RECHAZADO')");
    } else if (estado_duracion === 'OBSERVADO') {
      whereA.push("(a.estado = 'OBSERVADO' OR (a.hora_salida IS NULL AND a.fecha < CURDATE()))");
    }

    if (mod === 'PRESENCIAL') {
      whereA.push("(ag.modalidad = 'PRESENCIAL' OR ag.modalidad IS NULL)");
    } else if (mod === 'TELETRABAJO') {
      whereA.push("ag.modalidad = 'TELETRABAJO'");
    }

    if (fechasRaw) {
      if (fechasRaw.includes(' to ') || fechasRaw.includes(' a ')) {
        const parts = fechasRaw.split(/\s+(?:to|a)\s+/);
        if (parts.length === 2 && parts[0] && parts[1]) {
          whereA.push('a.fecha BETWEEN ? AND ?');
          paramsA.push(parts[0].trim(), parts[1].trim());
        } else if (parts[0]) {
          whereA.push('a.fecha = ?');
          paramsA.push(parts[0].trim());
        }
      } else {
        const dateList = fechasRaw.split(/[,;\s]+/).map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (dateList.length === 1) {
          whereA.push('a.fecha = ?');
          paramsA.push(dateList[0]);
        } else if (dateList.length > 1) {
          whereA.push(`a.fecha IN (${dateList.map(() => '?').join(', ')})`);
          paramsA.push(...dateList);
        }
      }
    }

    const [resA] = await db.query(
      `SELECT
        CAST(a.id_asistencia AS CHAR) AS id_asistencia,
        u.id_usuario,
        u.nombre AS usuario_nombre,
        u.CI AS usuario_ci,
        u.id_carrera,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        l.id_lugar,
        l.nombre AS lugar_nombre,
        l.tipo AS lugar_tipo,
        COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
        TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
        TIME_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
        IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
           TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
           NULL
        ) AS duracion_segundos,
        a.estado AS asistencia_estado,
        r.id_reporte,
        r.tarea,
        r.comprobante,
        COALESCE(r.observacion, a.observacion) AS observacion
      FROM asistencias a
      INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
      LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
      LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
      LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
      ${whereA.length ? 'WHERE ' + whereA.join(' AND ') : ''}`,
      paramsA
    );
    rowsA = resA || [];
  }

  // 2. Consulta de Horas Extras Aprobadas
  let rowsB = [];
  const includeHE = mod !== 'PRESENCIAL' && mod !== 'TELETRABAJO' && !id_lugar && estado_duracion !== 'OBSERVADO' && estado_duracion !== 'EN_CURSO';

  if (includeHE) {
    const whereB = ["n.estado = 2"];
    const paramsB = [];

    if (id_carrera) {
      whereB.push('u.id_carrera = ?');
      paramsB.push(id_carrera);
    }
    if (id_usuario) {
      whereB.push('n.id_usuario = ?');
      paramsB.push(id_usuario);
    } else if (nombre) {
      whereB.push('u.nombre LIKE ?');
      paramsB.push(`%${nombre}%`);
    }
    if (fechasRaw) {
      if (fechasRaw.includes(' to ') || fechasRaw.includes(' a ')) {
        const parts = fechasRaw.split(/\s+(?:to|a)\s+/);
        if (parts.length === 2 && parts[0] && parts[1]) {
          whereB.push('n.fecha_solicitada BETWEEN ? AND ?');
          paramsB.push(parts[0].trim(), parts[1].trim());
        } else if (parts[0]) {
          whereB.push('n.fecha_solicitada = ?');
          paramsB.push(parts[0].trim());
        }
      } else {
        const dateList = fechasRaw.split(/[,;\s]+/).map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (dateList.length === 1) {
          whereB.push('n.fecha_solicitada = ?');
          paramsB.push(dateList[0]);
        } else if (dateList.length > 1) {
          whereB.push(`n.fecha_solicitada IN (${dateList.map(() => '?').join(', ')})`);
          paramsB.push(...dateList);
        }
      }
    }

    const [resB] = await db.query(
      `SELECT
        CONCAT('he_', n.id_notificacion) AS id_asistencia,
        u.id_usuario,
        u.nombre AS usuario_nombre,
        u.CI AS usuario_ci,
        u.id_carrera,
        DATE_FORMAT(n.fecha_solicitada, '%Y-%m-%d') AS fecha,
        NULL AS id_lugar,
        'Horas Extras' AS lugar_nombre,
        'HORA_EXTRA' AS lugar_tipo,
        'HORA_EXTRA' AS modalidad,
        TIME_FORMAT(n.hora_inicio, '%H:%i') AS hora_entrada,
        TIME_FORMAT(n.hora_fin, '%H:%i') AS hora_salida,
        IF(n.hora_fin IS NOT NULL AND n.hora_inicio IS NOT NULL,
           TIMESTAMPDIFF(SECOND, TIMESTAMP(n.fecha_solicitada, n.hora_inicio), TIMESTAMP(n.fecha_solicitada, n.hora_fin)),
           NULL
        ) AS duracion_segundos,
        'FINALIZADO' AS asistencia_estado,
        NULL AS id_reporte,
        n.tarea,
        n.comprobante,
        n.observacion_admin AS observacion
      FROM notificaciones n
      INNER JOIN usuarios u ON u.id_usuario = n.id_usuario
      ${whereB.length ? 'WHERE ' + whereB.join(' AND ') : ''}`,
      paramsB
    );
    rowsB = resB || [];
  }

  const allRows = [...rowsA, ...rowsB];
  allRows.sort((a, b) => {
    const keyA = `${a.fecha || ''} ${a.hora_entrada || ''}`;
    const keyB = `${b.fecha || ''} ${b.hora_entrada || ''}`;
    return keyB.localeCompare(keyA);
  });

  return allRows;
}

/* ==========================================================================
   API: LISTAR JORNADAS Y BITÁCORAS (PAGINADO Y FILTRADO)
   ========================================================================== */
router.get('/api/admin/reportes', requireAdmin, async (req, res) => {
  try {
    const id_carrera = req.query.id_carrera ? parseInt(req.query.id_carrera, 10) : (req.query.carrera ? parseInt(req.query.carrera, 10) || null : null);
    const estado_duracion = (req.query.estado_duracion || '').trim();
    const modalidad = (req.query.modalidad || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fechasRaw = (req.query.fechas || req.query.fecha || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    let size = Math.max(parseInt(req.query.size || '25', 10), 1);
    size = Math.min(size, 200);

    const offset = (page - 1) * size;

    // 1. Obtener registros combinados sin colisiones de colación SQL
    const allRows = await fetchCombinedRecords({
      id_carrera,
      estado_duracion,
      id_usuario,
      id_lugar,
      nombre,
      fechasRaw,
      modalidad
    });

    const total = allRows.length;

    // 2. Total de horas acumuladas y congeladas calculadas en segundos para el filtro actual
    // Formato de fecha actual YYYY-MM-DD para comparación estricta de cadenas (Bolivia UTC-4)
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    let totalSegundos = 0;
    let totalSegundosCongelados = 0;
    for (const r of allRows) {
      if (r.duracion_segundos != null && !['ANULADO', 'RECHAZADO'].includes(r.asistencia_estado)) {
        totalSegundos += Number(r.duracion_segundos) || 0;
        const sinTarea = !r.tarea || !r.tarea.trim();
        const esPasada = r.fecha && r.fecha < todayStr;
        const estaCongeladaUObs = ['CONGELADO', 'OBSERVADO'].includes(r.asistencia_estado);
        const estaBloqueadaSinBitacora = esPasada && sinTarea && r.asistencia_estado !== 'HABILITADO_EDICION';

        if (estaCongeladaUObs || estaBloqueadaSinBitacora) {
          totalSegundosCongelados += Number(r.duracion_segundos) || 0;
        }
      }
    }
    const totalSegundosDisponibles = Math.max(0, totalSegundos - totalSegundosCongelados);

    const totalAcumulada = formatSecondsToHHMMSS(totalSegundos);
    const totalCongeladas = formatSecondsToHHMMSS(totalSegundosCongelados);
    const totalDisponibles = formatSecondsToHHMMSS(totalSegundosDisponibles);

    // 3. Consulta de información del usuario si está seleccionado
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

    // 4. Registros paginados
    const pagedRows = allRows.slice(offset, offset + size);

    const formattedRows = pagedRows.map((r) => {
      const isPast = Boolean(r.fecha && r.fecha < todayStr);
      const sinTarea = !r.tarea || !r.tarea.trim();
      let estadoCalculado = 'FINALIZADO';
      let horasDiaText = '00:00';

      if (r.modalidad === 'HORA_EXTRA') {
        estadoCalculado = 'FINALIZADO';
        horasDiaText = r.duracion_segundos != null ? formatSecondsToHHMM(r.duracion_segundos) : '00:00';
      } else if (r.asistencia_estado === 'CONGELADO') {
        estadoCalculado = 'CONGELADO';
        horasDiaText = r.duracion_segundos != null ? formatSecondsToHHMM(r.duracion_segundos) : 'Congelada';
      } else if (r.asistencia_estado === 'HABILITADO_EDICION') {
        estadoCalculado = 'HABILITADO_EDICION';
        horasDiaText = r.duracion_segundos != null ? formatSecondsToHHMM(r.duracion_segundos) : 'Reactivada';
      } else if (r.asistencia_estado === 'OBSERVADO') {
        estadoCalculado = 'OBSERVADO';
        horasDiaText = 'Observación';
      } else if (r.asistencia_estado === 'RECHAZADO') {
        estadoCalculado = 'RECHAZADO';
        horasDiaText = 'Rechazado';
      } else if (isPast && sinTarea && r.asistencia_estado !== 'HABILITADO_EDICION') {
        estadoCalculado = 'OBSERVADO';
        horasDiaText = r.duracion_segundos != null ? formatSecondsToHHMM(r.duracion_segundos) : 'Observación';
      } else if (r.duracion_segundos != null) {
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

    // 5. Estadísticas dinámicas para el panel lateral derecho:
    let statsData = {};

    if (id_usuario || (usuarioInfo && usuarioInfo.id_usuario)) {
      // 5.1. Estadísticas del usuario individual calculadas sobre los registros
      const finalizadas = allRows.filter(r => r.duracion_segundos != null && !['ANULADO', 'OBSERVADO', 'RECHAZADO'].includes(r.asistencia_estado));
      const enCurso = allRows.filter(r => !r.hora_salida && !['ANULADO', 'RECHAZADO'].includes(r.asistencia_estado));
      const completadasBit = allRows.filter(r => r.tarea && r.tarea.trim());
      const compSubidos = allRows.filter(r => r.comprobante && r.comprobante.trim());

      const sumFinalizadas = finalizadas.reduce((acc, curr) => acc + (Number(curr.duracion_segundos) || 0), 0);
      const promSeg = finalizadas.length > 0 ? Math.round(sumFinalizadas / finalizadas.length) : 0;
      const promHoras = (promSeg / 3600).toFixed(1);

      // Desglose por obra / lugar (incluye Horas Extras)
      const lugarMap = {};
      allRows.forEach(r => {
        const key = r.lugar_nombre || 'Sin lugar asignado';
        if (!lugarMap[key]) {
          lugarMap[key] = {
            lugar_nombre: key,
            lugar_tipo: r.lugar_tipo || '',
            total_dias: 0,
            total_segundos: 0
          };
        }
        lugarMap[key].total_dias += 1;
        if (r.duracion_segundos != null && !['ANULADO', 'OBSERVADO', 'RECHAZADO'].includes(r.asistencia_estado)) {
          lugarMap[key].total_segundos += Number(r.duracion_segundos) || 0;
        }
      });

      const formattedLugares = Object.values(lugarMap)
        .sort((a, b) => b.total_segundos - a.total_segundos)
        .map(l => ({
          ...l,
          horas_formateadas: formatSecondsToHHMM(l.total_segundos),
          horas_decimal: (l.total_segundos / 3600).toFixed(1),
          porcentaje: Math.min(100, Math.round((l.total_segundos / (totalSegundos || 1)) * 100))
        }));

      statsData = {
        tipo: 'usuario',
        total_asistencias: allRows.length,
        asistencias_finalizadas: finalizadas.length,
        asistencias_en_curso: enCurso.length,
        promedio_horas_dia: `${promHoras} hrs/día`,
        bitacoras_completadas: completadasBit.length,
        comprobantes_subidos: compSubidos.length,
        lugares_desglose: formattedLugares
      };
    } else {
      // 5.2. Estadísticas globales (Ranking de horas oficiales por pasante sin UNION colaciones)
      const [users] = await db.query(
        `SELECT u.id_usuario, u.nombre, u.CI, u.universidad, COALESCE(c.nombre, '') AS carrera
         FROM usuarios u
         LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
         WHERE u.rol = 0`
      );

      const [userAsistencias] = await db.query(
        `SELECT 
           id_usuario,
           COUNT(id_asistencia) AS total_dias,
           COALESCE(SUM(IF(hora_entrada IS NOT NULL AND hora_salida IS NOT NULL AND estado NOT IN ('ANULADO', 'OBSERVADO', 'RECHAZADO'),
                           TIMESTAMPDIFF(SECOND, TIMESTAMP(fecha, hora_entrada), TIMESTAMP(fecha, hora_salida)),
                           0)), 0) AS total_segundos
         FROM asistencias
         WHERE estado != 'ANULADO'
         GROUP BY id_usuario`
      );

      const [userHE] = await db.query(
        `SELECT 
           id_usuario,
           COUNT(id_notificacion) AS total_dias_he,
           COALESCE(SUM(IF(hora_inicio IS NOT NULL AND hora_fin IS NOT NULL,
                           TIMESTAMPDIFF(SECOND, TIMESTAMP(fecha_solicitada, hora_inicio), TIMESTAMP(fecha_solicitada, hora_fin)),
                           0)), 0) AS total_segundos_he
         FROM notificaciones
         WHERE estado = 2
         GROUP BY id_usuario`
      );

      const mapAsist = {};
      (userAsistencias || []).forEach(a => { mapAsist[a.id_usuario] = a; });
      const mapHE = {};
      (userHE || []).forEach(h => { mapHE[h.id_usuario] = h; });

      const userRankList = (users || []).map(u => {
        const a = mapAsist[u.id_usuario] || { total_dias: 0, total_segundos: 0 };
        const h = mapHE[u.id_usuario] || { total_dias_he: 0, total_segundos_he: 0 };
        const totalSeg = (Number(a.total_segundos) || 0) + (Number(h.total_segundos_he) || 0);
        const totalDias = (Number(a.total_dias) || 0) + (Number(h.total_dias_he) || 0);
        return {
          id_usuario: u.id_usuario,
          nombre: u.nombre,
          CI: u.CI,
          carrera: u.carrera,
          universidad: u.universidad,
          total_dias: totalDias,
          total_segundos: totalSeg
        };
      });

      userRankList.sort((a, b) => b.total_segundos - a.total_segundos);
      const top6 = userRankList.slice(0, 6);
      const maxSegundos = top6.length > 0 && top6[0].total_segundos > 0 ? top6[0].total_segundos : 1;

      const formattedTop = top6.map((u, idx) => ({
        ...u,
        horas_formateadas: formatSecondsToHHMMSS(u.total_segundos),
        horas_decimal: (u.total_segundos / 3600).toFixed(1),
        porcentaje_relativo: Math.min(100, Math.round((u.total_segundos / maxSegundos) * 100)),
        ranking: idx + 1
      }));

      statsData = {
        tipo: 'global',
        top_usuarios: formattedTop,
        total_pasantes_ranking: users.length
      };
    }

    // 5.3. Series temporales para gráficos interactivos (Horas oficiales por Semana y por Día de la Semana)
    const weekMap = {};
    const diasNombresList = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const diaStats = [0, 1, 2, 3, 4, 5, 6].map(idx => ({
      dia_idx: idx,
      dia_nombre: diasNombresList[idx],
      total_horas: 0,
      promedio_horas: 0,
      total_asistencias: 0
    }));

    allRows.forEach(r => {
      if (r.duracion_segundos != null && !['ANULADO', 'OBSERVADO', 'RECHAZADO'].includes(r.asistencia_estado) && r.fecha) {
        const d = new Date(r.fecha + 'T12:00:00');
        if (!isNaN(d.getTime())) {
          // Semana inicio (Lunes)
          const day = d.getDay();
          const diff = d.getDate() - day + (day === 0 ? -6 : 1);
          const mon = new Date(d);
          mon.setDate(diff);
          const monStr = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
          if (!weekMap[monStr]) {
            weekMap[monStr] = {
              semana_inicio: monStr,
              semana_label: `Sem ${monStr.slice(5)}`,
              horas: 0,
              total_dias: 0
            };
          }
          weekMap[monStr].horas += Number((r.duracion_segundos / 3600).toFixed(2));
          weekMap[monStr].total_dias += 1;

          // Día de la semana (0=Lunes ... 6=Domingo)
          const diaIdx = (day === 0 ? 6 : day - 1);
          diaStats[diaIdx].total_horas += Number((r.duracion_segundos / 3600).toFixed(2));
          diaStats[diaIdx].total_asistencias += 1;
        }
      }
    });

    const series_semanal = Object.values(weekMap)
      .sort((a, b) => a.semana_inicio.localeCompare(b.semana_inicio))
      .slice(-15)
      .map(s => ({
        ...s,
        horas: Number(s.horas.toFixed(1))
      }));

    diaStats.forEach(d => {
      d.total_horas = Number(d.total_horas.toFixed(1));
      d.promedio_horas = d.total_asistencias > 0 ? Number((d.total_horas / d.total_asistencias).toFixed(1)) : 0;
    });

    statsData.series_semanal = series_semanal;
    statsData.series_dias_semana = diaStats;
    statsData.total_congeladas = totalCongeladas;
    statsData.total_congeladas_decimal = (totalSegundosCongelados / 3600).toFixed(1);
    statsData.total_disponibles = totalDisponibles;
    statsData.total_disponibles_decimal = (totalSegundosDisponibles / 3600).toFixed(1);

    res.json({
      ok: true,
      data: formattedRows,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      total_acumulada: totalAcumulada,
      total_horas_decimal: (totalSegundos / 3600).toFixed(1),
      total_congeladas: totalCongeladas,
      total_congeladas_decimal: (totalSegundosCongelados / 3600).toFixed(1),
      total_disponibles: totalDisponibles,
      total_disponibles_decimal: (totalSegundosDisponibles / 3600).toFixed(1),
      usuario_info: usuarioInfo,
      stats: statsData
    });
  } catch (e) {
    console.error('Error en /api/admin/reportes:', e);
    res.status(500).json({ ok: false, error: 'Error al consultar asistencias y reportes' });
  }
});

/* ==========================================================================
   API: ACTIVAR / DESACTIVAR (CONGELAR / REACTIVAR) BITÁCORA Y HORAS
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia/toggle-estado', requireAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id_asistencia || '').trim();
    if (!rawId) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    if (rawId.startsWith('he_')) {
      return res.status(400).json({ ok: false, msg: 'Las horas extras se gestionan mediante su aprobación.' });
    }

    const id_asistencia = parseInt(rawId, 10);
    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID numérico inválido' });

    const [rows] = await db.query(
      `SELECT a.id_asistencia, a.estado, a.fecha, r.tarea 
       FROM asistencias a 
       LEFT JOIN reportes r ON a.id_asistencia = r.id_asistencia 
       WHERE a.id_asistencia = ? 
       LIMIT 1`, 
      [id_asistencia]
    );
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Asistencia no encontrada' });

    const row = rows[0];
    const estaInactivo = ['CONGELADO', 'OBSERVADO'].includes(row.estado) || (!row.tarea && row.estado !== 'HABILITADO_EDICION');

    if (estaInactivo) {
      // Activar / Reactivar -> HABILITADO_EDICION (permite editar bitácora y descongela horas)
      await db.query(
        `UPDATE asistencias 
         SET estado = 'HABILITADO_EDICION',
             observacion = 'Bitácora reactivada por el Administrador. Horas habilitadas.',
             actualizado_en = NOW()
         WHERE id_asistencia = ?`,
        [id_asistencia]
      );
      return res.json({
        ok: true,
        nuevo_estado: 'HABILITADO_EDICION',
        accion: 'activar',
        msg: 'Bitácora activada con éxito. El pasante ya puede registrarla y las horas están disponibles.'
      });
    } else {
      // Desactivar -> CONGELADO (bloquea edición y congela horas)
      await db.query(
        `UPDATE asistencias 
         SET estado = 'CONGELADO',
             actualizado_en = NOW()
         WHERE id_asistencia = ?`,
        [id_asistencia]
      );
      return res.json({
        ok: true,
        nuevo_estado: 'CONGELADO',
        accion: 'desactivar',
        msg: 'Bitácora desactivada. Las horas han sido congeladas.'
      });
    }
  } catch (e) {
    console.error('Error al cambiar estado de bitácora:', e);
    res.status(500).json({ ok: false, msg: 'Error interno al cambiar el estado de la bitácora' });
  }
});

/* ==========================================================================
   API: REACTIVAR BITÁCORA OBSERVADA / BLOQUEADA DESDE ADMINISTRADOR
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia/reactivar', requireAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id_asistencia || '').trim();
    if (!rawId) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    if (rawId.startsWith('he_')) {
      return res.status(400).json({ ok: false, msg: 'Las horas extras no requieren reactivación manual.' });
    }

    const id_asistencia = parseInt(rawId, 10);
    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID numérico inválido' });

    // Actualizar estado a HABILITADO_EDICION para permitir que el usuario edite/envíe su bitácora
    await db.query(
      `UPDATE asistencias 
       SET estado = 'HABILITADO_EDICION',
           observacion = 'Bitácora reactivada por el Administrador para su registro/edición.',
           actualizado_en = NOW()
       WHERE id_asistencia = ?`,
      [id_asistencia]
    );

    res.json({
      ok: true,
      msg: 'Bitácora reactivada exitosamente. El usuario ya tiene permiso para completarla o editarla.'
    });
  } catch (e) {
    console.error('Error al reactivar bitácora:', e);
    res.status(500).json({ ok: false, msg: 'Error interno al reactivar la bitácora' });
  }
});

/* ==========================================================================
   API: CONGELAR / DESCONGELAR HORAS DE UNA JORNADA
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia/congelar', requireAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id_asistencia || '').trim();
    if (!rawId) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    if (rawId.startsWith('he_')) {
      return res.status(400).json({ ok: false, msg: 'No se puede congelar una hora extra individualmente.' });
    }

    const id_asistencia = parseInt(rawId, 10);
    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID numérico inválido' });

    const [rows] = await db.query('SELECT id_asistencia, estado FROM asistencias WHERE id_asistencia = ? LIMIT 1', [id_asistencia]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Asistencia no encontrada' });

    const estadoActual = rows[0].estado;
    if (estadoActual === 'CONGELADO') {
      // Descongelar -> pasar a PRESENTE
      await db.query(`UPDATE asistencias SET estado = 'PRESENTE', actualizado_en = NOW() WHERE id_asistencia = ?`, [id_asistencia]);
      return res.json({
        ok: true,
        accion: 'descongelar',
        msg: 'Horas descongeladas con éxito. Ahora se contabilizan como disponibles.'
      });
    } else {
      // Congelar
      await db.query(`UPDATE asistencias SET estado = 'CONGELADO', actualizado_en = NOW() WHERE id_asistencia = ?`, [id_asistencia]);
      return res.json({
        ok: true,
        accion: 'congelar',
        msg: 'Horas congeladas con éxito. Han sido descontadas de las horas disponibles.'
      });
    }
  } catch (e) {
    console.error('Error al congelar/descongelar horas:', e);
    res.status(500).json({ ok: false, msg: 'Error interno al procesar las horas' });
  }
});

/* ==========================================================================
   API: ACTUALIZAR HORAS Y OBSERVACIÓN DEL ADMIN EN LA ASISTENCIA / BITÁCORA
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia', requireAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id_asistencia || '').trim();
    const { observacion, hora_entrada, hora_salida } = req.body || {};

    if (!rawId) return res.status(400).json({ ok: false, msg: 'ID no válido' });

    const valEntrada = hora_entrada && hora_entrada.trim() ? hora_entrada.trim() : null;
    const valSalida = hora_salida && hora_salida.trim() && hora_salida.trim() !== '-' ? hora_salida.trim() : null;
    const valObs = observacion && observacion.trim() ? observacion.trim() : null;

    if (rawId.startsWith('he_')) {
      const idNotif = parseInt(rawId.replace('he_', ''), 10);
      await db.query(
        `UPDATE notificaciones 
         SET hora_inicio = ?, hora_fin = ?, observacion_admin = ?
         WHERE id_notificacion = ?`,
        [valEntrada, valSalida, valObs, idNotif]
      );
      // Actualizar también en reportes si existe bitácora insertada
      await db.query(
        `UPDATE reportes r
         INNER JOIN notificaciones n ON n.id_usuario = r.id_usuario AND n.fecha_solicitada = r.fecha
         SET r.hora_inicio = ?, r.hora_fin = ?, r.observacion = ?
         WHERE n.id_notificacion = ? AND r.id_asistencia IS NULL`,
        [valEntrada, valSalida, valObs, idNotif]
      );
      return res.json({ ok: true, msg: 'Horas extras actualizadas correctamente' });
    }

    const id_asistencia = parseInt(rawId, 10);
    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

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
   API: ANULAR / ELIMINAR ASISTENCIA O HORAS EXTRAS (CANDADO ANULADO)
   ========================================================================== */
router.delete('/api/admin/reportes/:id_asistencia', requireAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id_asistencia || '').trim();
    if (!rawId) return res.status(400).json({ ok: false, msg: 'ID no válido' });

    if (rawId.startsWith('he_')) {
      const idNotif = parseInt(rawId.replace('he_', ''), 10);
      await db.query("UPDATE notificaciones SET estado = 3 WHERE id_notificacion = ?", [idNotif]);
      await db.query(
        `DELETE r FROM reportes r
         INNER JOIN notificaciones n ON n.id_usuario = r.id_usuario AND n.fecha_solicitada = r.fecha
         WHERE n.id_notificacion = ? AND r.id_asistencia IS NULL`,
        [idNotif]
      );
      return res.json({ ok: true, msg: 'Registro de horas extras anulado correctamente' });
    }

    const id_asistencia = parseInt(rawId, 10);
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
         COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
         a.estado AS asistencia_estado,
         IF(a.hora_salida IS NOT NULL AND a.hora_entrada IS NOT NULL,
            TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
            NULL
         ) AS duracion_segundos,
         r.id_reporte,
         r.tarea,
         r.comprobante,
         COALESCE(r.observacion, a.observacion) AS observacion
       FROM asistencias a
       LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
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

      if (a.asistencia_estado === 'OBSERVADO' || a.estado === 'OBSERVADO') {
        estado = 'OBSERVADO';
        horasTxt = 'Observación';
      } else if (a.asistencia_estado === 'RECHAZADO' || a.estado === 'RECHAZADO') {
        estado = 'RECHAZADO';
        horasTxt = 'Rechazado';
      } else if (a.duracion_segundos != null) {
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
    const modalidad = (req.query.modalidad || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fechasRaw = (req.query.fechas || req.query.fecha || '').trim();

    const reports = await fetchCombinedRecords({
      id_carrera,
      estado_duracion,
      id_usuario,
      id_lugar,
      nombre,
      fechasRaw,
      modalidad
    });

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

    if (modalidad === 'HORA_EXTRA' || modalidad === 'HORAS_EXTRAS') {
      userTitle += ' [Horas Extras Aprobadas]';
      fileSuffix += '_horas_extras';
    } else if (modalidad === 'TELETRABAJO') {
      userTitle += ' [Teletrabajo]';
      fileSuffix += '_teletrabajo';
    } else if (modalidad === 'PRESENCIAL') {
      userTitle += ' [Presencial]';
      fileSuffix += '_presencial';
    }

    let totalSegundos = 0;
    for (const r of reports) {
      if (r.duracion_segundos != null && !['ANULADO', 'OBSERVADO', 'RECHAZADO'].includes(r.asistencia_estado)) {
        totalSegundos += Number(r.duracion_segundos) || 0;
      }
    }
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
    ws.addRow(['Usuario', 'CI', 'Fecha', 'Lugar / Modalidad', 'Hora Entrada', 'Hora Salida', 'Duración', 'Tarea (Bitácora)', 'Observación Admin']);

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
      { key: 'lugar', width: 25 },
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
        let lugarTexto = r.lugar_nombre || 'N/A';
        if (r.modalidad === 'HORA_EXTRA') {
          lugarTexto = '⚡ Horas Extras (Aprobadas)';
        } else if (r.modalidad === 'TELETRABAJO') {
          lugarTexto = 'Teletrabajo (Remoto)';
        }

        let horasTexto = 'En curso';
        if (r.modalidad === 'HORA_EXTRA') {
          horasTexto = r.duracion_segundos != null ? formatSecondsToHHMMSS(r.duracion_segundos) : '00:00:00';
        } else if (r.asistencia_estado === 'OBSERVADO') {
          horasTexto = 'Observación';
        } else if (r.asistencia_estado === 'RECHAZADO') {
          horasTexto = 'Rechazado';
        } else if (r.duracion_segundos != null) {
          horasTexto = formatSecondsToHHMMSS(r.duracion_segundos);
        }

        ws.addRow({
          nombre: r.usuario_nombre,
          ci: r.usuario_ci,
          fecha: r.fecha,
          lugar: lugarTexto,
          hora_entrada: r.hora_entrada || '-',
          hora_salida: r.hora_salida || '-',
          horas_trabajadas: horasTexto,
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
    console.error('Error al exportar Excel:', e);
    res.status(500).send('No se pudo generar el Excel.');
  }
});

module.exports = router;
