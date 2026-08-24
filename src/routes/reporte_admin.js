const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const ExcelJS = require('exceljs');


// Middleware de autorización para el rol de administrador
function requireAdmin(req, res, next) {
  if (req.session.user.rol !== 1) return res.status(403).send('No autorizado');
  next();
}

/* ==========================================================================
   VISTA: RENDERIZAR PANEL ADMINISTRATIVO DE REPORTES
   ========================================================================== */
/* ==========================================
   VISTA: Admin - Reportes
   ========================================== */
router.get('/admin/reportes', requireAdmin, async (req, res) => {
  try {
    // 1. Consultar usuarios para el <select>
    const [usuarios] = await db.query('SELECT id_usuario, nombre, CI FROM usuarios ORDER BY nombre ASC');

    // 2. Pasar 'usuarios' a la vista
    res.render('reporte_admin', {
      filtroCI: '',
      user: req.session.user,
      usuarios: usuarios || [] // Se pasa la lista de usuarios
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
    const id_usuario = req.query.id_usuario || '';
    const fecha = req.query.fecha || '';
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

    // Consulta unificada: Asistencia + Lugar + Bitácora (Reporte)
    const [rows] = await db.query(
      `SELECT
         a.id_asistencia,
         u.nombre AS usuario_nombre,
         u.CI AS usuario_ci,
         DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
         l.nombre AS lugar_nombre,
         l.tipo AS lugar_tipo,
         
         -- Horarios reales/biométricos de entrada y salida
         TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_entrada), a.hora_entrada), '%H:%i') AS hora_entrada,
         TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_salida), a.hora_salida), '%H:%i') AS hora_salida,
         
         -- Cálculo de tiempo trabajado
         IF(a.hora_salida IS NOT NULL, TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i'), 'En curso') AS horas_dia,
         
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

    res.json({
      ok: true,
      data: rows,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error al consultar asistencias y reportes' });
  }
});

/* ==========================================================================
   API: ACTUALIZAR OBSERVACIÓN DEL ADMIN EN LA ASISTENCIA / BITÁCORA
   ========================================================================== */
router.post('/api/admin/reportes/:id_asistencia', requireAdmin, async (req, res) => {
  try {
    const id_asistencia = parseInt(req.params.id_asistencia, 10);
    const { observacion } = req.body || {};

    if (!id_asistencia) return res.status(400).json({ ok: false, msg: 'ID de asistencia no válido' });

    // Actualizar observación en la tabla asistencias
    await db.query('UPDATE asistencias SET observacion = ? WHERE id_asistencia = ?', [observacion || null, id_asistencia]);

    // Si existe bitácora vinculada, actualizarla también
    await db.query('UPDATE reportes SET observacion = ? WHERE id_asistencia = ?', [observacion || null, id_asistencia]);

    res.json({ ok: true, msg: 'Observación actualizada correctamente' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error interno al actualizar la observación' });
  }
});

/* ==========================================================================
   EXPORTAR CONSOLIDADO A EXCEL
   ========================================================================== */
router.get('/admin/reportes/export', requireAdmin, async (req, res) => {
  try {
    const ci = (req.query.ci || '').trim();
    const fecha = req.query.fecha || '';

    const where = [];
    const params = [];
    if (ci) {
      where.push('u.CI LIKE ?');
      params.push(`%${ci}%`);
    }
    if (fecha) {
      where.push('a.fecha = ?');
      params.push(fecha);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [reports] = await db.query(
      `SELECT
         u.nombre, 
         u.CI,
         DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
         l.nombre AS lugar,
         TIME_FORMAT(a.hora_entrada, '%H:%i:%s') AS hora_entrada,
         TIME_FORMAT(a.hora_salida, '%H:%i:%s') AS hora_salida,
         IF(a.hora_salida IS NOT NULL, TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i:%s'), '00:00:00') AS horas_trabajadas,
         r.tarea, 
         COALESCE(r.observacion, a.observacion) AS observacion
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
       LEFT JOIN reportes r ON r.id_asistencia = a.id_asistencia
       ${whereSQL}
       ORDER BY a.fecha DESC`,
      params
    );

    const [tRow] = await db.query(
      `SELECT COALESCE(
         SEC_TO_TIME(SUM(TIME_TO_SEC(TIMEDIFF(a.hora_salida, a.hora_entrada)))), '00:00:00'
       ) AS total_acumulada
       FROM asistencias a
       INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
       ${whereSQL} AND a.hora_salida IS NOT NULL`,
      params
    );

    const totalAcum = tRow?.[0]?.total_acumulada || '00:00:00';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reporte General');

    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = ci ? `Reporte General - CI Filtro: ${ci}` : 'Reporte General de Asistencias y Bitácoras';
    ws.getCell('A1').font = { bold: true, size: 14 };

    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `Generado el: ${new Date().toLocaleString()}  •  Horas Totales Acumuladas: ${totalAcum}`;
    ws.getCell('A2').font = { italic: true, size: 11 };

    ws.addRow([]);
    ws.addRow(['Usuario', 'CI', 'Fecha', 'Lugar / Obra', 'Hora Entrada', 'Hora Salida', 'Duración', 'Tarea (Bitácora)', 'Observación Admin']);
    
    const headerRow = ws.getRow(4);
    headerRow.font = { bold: true };

    ws.columns = [
      { key: 'nombre', width: 25 },
      { key: 'ci', width: 14 },
      { key: 'fecha', width: 12 },
      { key: 'lugar', width: 20 },
      { key: 'hora_entrada', width: 14 },
      { key: 'hora_salida', width: 14 },
      { key: 'horas_trabajadas', width: 14 },
      { key: 'tarea', width: 35 },
      { key: 'observacion', width: 30 }
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
          horas_trabajadas: r.horas_trabajadas,
          tarea: r.tarea || 'Sin bitácora registrada',
          observacion: r.observacion || ''
        });
      }
    }

    const startRow = 5;
    for (let i = startRow; i <= ws.lastRow.number; i++) {
      ws.getRow(i).eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    }

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    const filename = `reporte_admin_${new Date().toISOString().slice(0, 10)}.xlsx`;
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
