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
    // 1. Consultar usuarios para el autocompletado y filtros
    const [usuarios] = await db.query(
      'SELECT id_usuario, nombre, CI, universidad, carrera FROM usuarios ORDER BY nombre ASC'
    );

    // 2. Consultar obras y lugares para el filtro
    const [lugares] = await db.query(
      'SELECT id_lugar, nombre, tipo FROM lugares ORDER BY nombre ASC'
    );

    // 3. Pasar 'usuarios' y 'lugares' a la vista
    res.render('reporte_admin', {
      filtroCI: '',
      user: req.session.user,
      usuarios: usuarios || [],
      lugares: lugares || []
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
    const ci = (req.query.ci || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fecha = (req.query.fecha || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    let size = Math.max(parseInt(req.query.size || '25', 10), 1);
    size = Math.min(size, 200);

    const offset = (page - 1) * size;
    const where = [];
    const params = [];

    if (ci) {
      where.push('u.CI LIKE ?');
      params.push(`%${ci}%`);
    }
    if (id_usuario) {
      where.push('u.id_usuario = ?');
      params.push(id_usuario);
    } else if (nombre) {
      where.push('u.nombre LIKE ?');
      params.push(`%${nombre}%`);
    }
    if (id_lugar) {
      where.push('a.id_lugar = ?');
      params.push(id_lugar);
    }
    if (fecha) {
      where.push('a.fecha = ?');
      params.push(fecha);
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
             TIMESTAMP(
               a.fecha, 
               COALESCE(
                 NULLIF(TRIM(a.hora_entrada), ''), 
                 TIME(a.fecha_hora_biometrico_entrada)
               )
             ),
             CASE 
               WHEN a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-') THEN 
                 TIMESTAMP(a.fecha, TRIM(a.hora_salida))
               WHEN a.fecha_hora_biometrico_salida IS NOT NULL THEN 
                 a.fecha_hora_biometrico_salida
               ELSE NULL
             END
           )
         ), 0
       ) AS total_segundos
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND (
         (a.hora_entrada IS NOT NULL AND TRIM(a.hora_entrada) NOT IN ('', '-')) OR
         (a.fecha_hora_biometrico_entrada IS NOT NULL)
       )
       AND (
         (a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-')) OR
         (a.fecha_hora_biometrico_salida IS NOT NULL)
       )`,
      params
    );

    const totalSegundos = totalsRows[0]?.total_segundos || 0;
    const totalAcumulada = formatSecondsToHHMMSS(totalSegundos);

    // Consulta de información del usuario si está seleccionado
    let usuarioInfo = null;
    if (id_usuario) {
      const [uRows] = await db.query(
        'SELECT id_usuario, nombre, CI, universidad, carrera FROM usuarios WHERE id_usuario = ? LIMIT 1',
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
         
         -- Horarios reales/biométricos de entrada y salida
         TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada)), '%H:%i') AS hora_entrada,
         TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)), '%H:%i') AS hora_salida,
         
         -- Duración en segundos si hay salida registrada
         CASE 
           WHEN (a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-')) OR a.fecha_hora_biometrico_salida IS NOT NULL THEN
             TIMESTAMPDIFF(
               SECOND,
               TIMESTAMP(
                 a.fecha, 
                 COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada))
               ),
               CASE 
                 WHEN a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-') THEN TIMESTAMP(a.fecha, TRIM(a.hora_salida))
                 WHEN a.fecha_hora_biometrico_salida IS NOT NULL THEN a.fecha_hora_biometrico_salida
                 ELSE NULL
               END
             )
           ELSE NULL
         END AS duracion_segundos,
         
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

    const formattedRows = rows.map((r) => ({
      ...r,
      horas_dia: r.duracion_segundos != null ? formatSecondsToHHMM(r.duracion_segundos) : 'En curso'
    }));

    res.json({
      ok: true,
      data: formattedRows,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      total_acumulada: totalAcumulada,
      usuario_info: usuarioInfo
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

    // Actualizar horas y observación en la tabla asistencias
    await db.query(
      `UPDATE asistencias 
       SET hora_entrada = ?, 
           hora_salida = ?, 
           observacion = ? 
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
   EXPORTAR CONSOLIDADO A EXCEL
   ========================================================================== */
router.get('/admin/reportes/export', requireAdmin, async (req, res) => {
  try {
    const ci = (req.query.ci || '').trim();
    const id_usuario = req.query.id_usuario ? parseInt(req.query.id_usuario, 10) : null;
    const id_lugar = req.query.id_lugar ? parseInt(req.query.id_lugar, 10) : null;
    const nombre = (req.query.nombre || req.query.q || '').trim();
    const fecha = (req.query.fecha || '').trim();

    const where = [];
    const params = [];
    if (ci) {
      where.push('u.CI LIKE ?');
      params.push(`%${ci}%`);
    }
    if (id_usuario) {
      where.push('u.id_usuario = ?');
      params.push(id_usuario);
    } else if (nombre) {
      where.push('u.nombre LIKE ?');
      params.push(`%${nombre}%`);
    }
    if (id_lugar) {
      where.push('a.id_lugar = ?');
      params.push(id_lugar);
    }
    if (fecha) {
      where.push('a.fecha = ?');
      params.push(fecha);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let userTitle = 'Reporte General de Asistencias y Bitácoras';
    let fileSuffix = 'general';
    if (id_usuario) {
      const [uRows] = await db.query('SELECT nombre, CI FROM usuarios WHERE id_usuario = ? LIMIT 1', [id_usuario]);
      if (uRows.length > 0) {
        userTitle = `Reporte de Asistencias y Bitácoras - ${uRows[0].nombre} (CI: ${uRows[0].CI})`;
        fileSuffix = uRows[0].nombre.replace(/\s+/g, '_').toLowerCase();
      }
    } else if (id_lugar) {
      const [lRows] = await db.query('SELECT nombre FROM lugares WHERE id_lugar = ? LIMIT 1', [id_lugar]);
      if (lRows.length > 0) {
        userTitle = `Reporte General - Obra/Lugar: ${lRows[0].nombre}`;
        fileSuffix = `lugar_${lRows[0].nombre.replace(/\s+/g, '_').toLowerCase()}`;
      }
    } else if (ci) {
      userTitle = `Reporte General - Filtro CI: ${ci}`;
      fileSuffix = `ci_${ci}`;
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
         TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada)), '%H:%i:%s') AS hora_entrada,
         TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)), '%H:%i:%s') AS hora_salida,
         CASE 
           WHEN (a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-')) OR a.fecha_hora_biometrico_salida IS NOT NULL THEN
             TIMESTAMPDIFF(
               SECOND,
               TIMESTAMP(
                 a.fecha, 
                 COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada))
               ),
               CASE 
                 WHEN a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-') THEN TIMESTAMP(a.fecha, TRIM(a.hora_salida))
                 WHEN a.fecha_hora_biometrico_salida IS NOT NULL THEN a.fecha_hora_biometrico_salida
                 ELSE NULL
               END
             )
           ELSE NULL
         END AS duracion_segundos,
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
             TIMESTAMP(
               a.fecha, 
               COALESCE(
                 NULLIF(TRIM(a.hora_entrada), ''), 
                 TIME(a.fecha_hora_biometrico_entrada)
               )
             ),
             CASE 
               WHEN a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-') THEN 
                 TIMESTAMP(a.fecha, TRIM(a.hora_salida))
               WHEN a.fecha_hora_biometrico_salida IS NOT NULL THEN 
                 a.fecha_hora_biometrico_salida
               ELSE NULL
             END
           )
         ), 0
       ) AS total_segundos
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL}
       AND (
         (a.hora_entrada IS NOT NULL AND TRIM(a.hora_entrada) NOT IN ('', '-')) OR
         (a.fecha_hora_biometrico_entrada IS NOT NULL)
       )
       AND (
         (a.hora_salida IS NOT NULL AND TRIM(a.hora_salida) NOT IN ('', '-')) OR
         (a.fecha_hora_biometrico_salida IS NOT NULL)
       )`,
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
