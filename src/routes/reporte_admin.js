
const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const ExcelJS = require('exceljs');

// (Opcional) middleware de autorización de admin
function requireAdmin(req, res, next) {
  // Ajusta según tu modelo de roles (ej.: 1=admin)
  if (!req.session?.user || req.session.user.rol !== 1) {
    return res.status(403).send('No autorizado');
  }
  next();
}

/* =========================
   VISTA: Admin - Reportes
   ========================= */
router.get('/admin/reportes', requireAdmin, (req, res) => {
  // Renderiza la página vacía; el listado se carga por fetch (JSON)
  res.render('reporte_admin', {
    filtroCI: '', // valor inicial del input
    user: req.session.user
  });
});

/* ==========================================
   API: Listar reportes (server-side paging)
   GET /api/admin/reportes?ci=xxxx&page=1&size=25
   ========================================== */
router.get('/api/admin/reportes', requireAdmin, async (req, res) => {
  try {
    const ci = (req.query.ci || '').trim();              // filtro exacto por CI (opcional)
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    let size = Math.max(parseInt(req.query.size || '25', 10), 1);
    size = Math.min(size, 200); // límite sano

    const offset = (page - 1) * size;

    const where = [];
    const params = [];
    if (ci) {
      where.push('u.CI = ?');
      params.push(ci);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Total
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM reportes r
       INNER JOIN usuarios u ON u.id_usuario = r.id_usuario
       ${whereSQL}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Datos
    const [rows] = await db.query(
      `SELECT
         r.id_reporte,
         u.nombre,
         u.CI,
         DATE_FORMAT(r.fecha, '%Y-%m-%d')          AS fecha,
         TIME_FORMAT(r.hora_acumulada, '%H:%i:%s') AS hora_acumulada,
         TIME_FORMAT(r.hora_inicio,   '%H:%i')     AS hora_inicio,
         TIME_FORMAT(r.hora_fin,      '%H:%i')     AS hora_fin,
         r.tarea, r.comprobante, r.observacion
       FROM reportes r
       INNER JOIN usuarios u ON u.id_usuario = r.id_usuario
       ${whereSQL}
       ORDER BY r.fecha DESC, r.id_reporte DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    res.json({
      ok: true,
      data: rows,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error listando reportes' });
  }
});

/* ==========================================
   API: Actualizar un reporte
   POST /api/admin/reportes/:id
   Body: hora_acumulada, hora_inicio, hora_fin, observacion
   ========================================== */
router.post('/api/admin/reportes/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, msg: 'ID inválido' });

    const { hora_acumulada, hora_inicio, hora_fin, observacion } = req.body || {};

    await db.query(
      `UPDATE reportes
       SET hora_acumulada = ?, hora_inicio = ?, hora_fin = ?, observacion = ?
       WHERE id_reporte = ?`,
      [hora_acumulada || null, hora_inicio || null, hora_fin || null, observacion || null, id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error al actualizar' });
  }
});

/* ==========================================
   EXPORT: Excel de todos o por CI
   GET /admin/reportes/export?ci=xxxx
   ========================================== */
router.get('/admin/reportes/export', requireAdmin, async (req, res) => {
  try {
    const ci = (req.query.ci || '').trim();

    const where = [];
    const params = [];
    if (ci) {
      where.push('u.CI = ?');
      params.push(ci);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Traer reportes
    const [reports] = await db.query(
      `SELECT
         u.nombre, u.CI,
         DATE_FORMAT(r.fecha, '%Y-%m-%d')          AS fecha,
         TIME_FORMAT(r.hora_acumulada, '%H:%i:%s') AS hora_acumulada,
         TIME_FORMAT(r.hora_inicio,   '%H:%i:%s')  AS hora_inicio,
         TIME_FORMAT(r.hora_fin,      '%H:%i:%s')  AS hora_fin,
         r.tarea, r.observacion
       FROM reportes r
       INNER JOIN usuarios u ON u.id_usuario = r.id_usuario
       ${whereSQL}
       ORDER BY r.fecha DESC, r.id_reporte DESC`,
      params
    );

    // Total acumulado (del conjunto filtrado)
    const [tRow] = await db.query(
      `SELECT COALESCE(SEC_TO_TIME(SUM(TIME_TO_SEC(r.hora_acumulada))), '00:00:00') AS total_acumulada
       FROM reportes r
       INNER JOIN usuarios u ON u.id_usuario = r.id_usuario
       ${whereSQL}`,
      params
    );
    const totalAcum = tRow?.[0]?.total_acumulada || '00:00:00';

    // Helpers para Excel
    const toExcelDate = (ymd) => {
      if (!ymd) return null;
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    };
    const toExcelTime = (hms) => {
      if (!hms) return null;
      const [h, m, s] = hms.split(':').map(x => parseInt(x || '0', 10));
      const secs = (h * 3600) + (m * 60) + (s || 0);
      return secs / 86400;
    };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reportes');

    // Título
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = ci ? `Reportes del CI: ${ci}` : 'Reportes - Todos los usuarios';
    ws.getCell('A1').font = { bold: true, size: 14 };

    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `Exportado: ${new Date().toLocaleString()}  •  Total horas acumuladas: ${totalAcum}`;
    ws.getCell('A2').font = { italic: true, size: 11 };

    ws.addRow([]);
    ws.addRow(['Nombre', 'CI', 'Fecha', 'Hora acumulada', 'Hora inicio', 'Hora fin', 'Tarea', 'Observaciones']);
    const headerRow = ws.getRow(ws.lastRow.number);
    headerRow.font = { bold: true };

    ws.columns = [
      { key: 'nombre', width: 26 },
      { key: 'ci', width: 14 },
      { key: 'fecha', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
      { key: 'hora_acumulada', width: 14, style: { numFmt: 'hh:mm:ss' } },
      { key: 'hora_inicio', width: 12, style: { numFmt: 'hh:mm:ss' } },
      { key: 'hora_fin', width: 12, style: { numFmt: 'hh:mm:ss' } },
      { key: 'tarea', width: 40 },
      { key: 'observacion', width: 40 },
    ];

    if (!reports.length) {
      ws.addRow(['Sin registros', '', null, null, null, null, '', '']);
    } else {
      for (const r of reports) {
        ws.addRow({
          nombre: r.nombre,
          ci: r.CI,
          fecha: toExcelDate(r.fecha),
          hora_acumulada: toExcelTime(r.hora_acumulada),
          hora_inicio: toExcelTime(r.hora_inicio),
          hora_fin: toExcelTime(r.hora_fin),
          tarea: r.tarea || '',
          observacion: r.observacion || ''
        });
      }
    }

    // Bordes y wrap
    const startRow = headerRow.number + 1;
    for (let i = startRow; i <= ws.lastRow.number; i++) {
      ws.getRow(i).eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    }

    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const safeCI = ci ? ci.replace(/[^\w-]/g, '_') : 'todos';
    const ymd = new Date().toISOString().slice(0, 10);
    const filename = `reportes_${safeCI}_${ymd}.xlsx`;

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
