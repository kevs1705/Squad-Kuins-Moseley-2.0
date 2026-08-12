const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const multer = require('multer');

router.get('/reporte', requireAuth, async (req, res) => {
  // Tomamos el ID del usuario autenticado
  const userId = req.session.user.id;

  try {
    // (Opcional) refrescar datos del usuario desde DB
    const [users] = await db.query(
      'SELECT id_usuario, nombre, CI, rol FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [userId]
    );

    if (users.length === 0) return res.status(404).send('Usuario no encontrado');

    const userDB = users[0];

    // Total acumulado
    const [totals] = await db.query(
      `SELECT COALESCE(SEC_TO_TIME(SUM(TIME_TO_SEC(hora_acumulada))), '00:00:00') AS total_acumulada
       FROM reportes
       WHERE id_usuario = ?`,
      [userId]
    );
    const total_acumulada = totals[0].total_acumulada;

    // Reportes del usuario
    const [reports] = await db.query(`
      SELECT
        DATE_FORMAT(fecha, '%Y-%m-%d')          AS fecha,
        TIME_FORMAT(hora_acumulada, '%H:%i:%s') AS hora_acumulada,
        TIME_FORMAT(hora_inicio, '%H:%i')       AS hora_inicio,
        TIME_FORMAT(hora_fin, '%H:%i')          AS hora_fin,
        tarea, comprobante, observacion
      FROM reportes
      WHERE id_usuario = ?
      ORDER BY fecha DESC, id_reporte DESC
    `, [userId]);

    // Puedes pasar lo que ya tienes en la sesión o lo recién consultado
    const user = {
      id: userDB.id_usuario,
      nombre: userDB.nombre,
      ci: userDB.CI,
      rol: userDB.rol
    };

    res.render('reporte', { user, total_acumulada, reports });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error consultando la base de datos');
  }
});



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
  if (m === 'image/png' || m === 'image/jpg' || m === 'image/jpeg') return cb(null, true);
  cb(new Error('Solo se permiten imágenes PNG o JPG/JPEG'));
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// ===== Helper: obtener reporte activo =====
async function getReporteActivo(userId) {
// En getReporteActivo o en cualquier SELECT
const [rows] = await db.query(`
  SELECT 
    id_reporte, 
    id_usuario, 
    DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,  -- 👈 aquí
    TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio,
    TIME_FORMAT(hora_fin, '%H:%i:%s') AS hora_fin,
    tarea, comprobante, observacion
  FROM reportes
  WHERE id_usuario = ? AND hora_fin IS NULL
  ORDER BY creado_en DESC
  LIMIT 1
`, [userId]);

  return rows[0] || null;
}

// ===== GET: reporte activo (JSON) =====
router.get('/reportes/active', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const activo = await getReporteActivo(userId);
    const [[{ server_now }]] = await db.query('SELECT NOW() AS server_now');
    return res.json({ ok: true, data: activo || null, now: server_now });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Error consultando reporte activo' });
  }
});

// ===== POST: comenzar nuevo reporte =====
router.post('/reportes/start', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Si ya hay uno activo, simplemente regrésalo
    const activo = await getReporteActivo(userId);
    if (activo) return res.json({ ok: true, data: activo, already: true });

    // Crear uno nuevo (fecha actual y hora de inicio ahora)
    const [result] = await db.query(`
      INSERT INTO reportes (id_usuario, fecha, hora_inicio)
      VALUES (?, CURDATE(), CURTIME())
    `, [userId]);

const [rows] = await db.query(`
  SELECT 
    id_reporte, 
    id_usuario, 
    DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,   -- 👈 fecha limpia
    TIME_FORMAT(hora_inicio, '%H:%i:%s') AS hora_inicio,
    TIME_FORMAT(hora_fin, '%H:%i:%s') AS hora_fin,
    tarea, comprobante, observacion
  FROM reportes
  WHERE id_reporte = ?
  LIMIT 1
`, [result.insertId]);

    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo iniciar el reporte' });
  }
});

// ===== POST: agregar/actualizar tarea (solo descripción) =====
router.post('/reportes/task', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id_reporte, tarea } = req.body;
    if (!id_reporte || !tarea) {
      return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    const [info] = await db.query(`
      UPDATE reportes
      SET tarea = ?
      WHERE id_reporte = ? AND id_usuario = ?
    `, [tarea, id_reporte, userId]);

    if (info.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Reporte no encontrado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la tarea' });
  }
});

// ===== POST: subir comprobante (PNG/JPG) =====
router.post('/reportes/comprobante', requireAuth, upload.single('comprobante'), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id_reporte } = req.body;
    if (!id_reporte) {
      return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Archivo no recibido o inválido' });
    }

    // Ruta pública para servir el archivo
    const publicPath = '/uploads/comprobantes/' + req.file.filename;

    const [info] = await db.query(`
      UPDATE reportes
      SET comprobante = ?
      WHERE id_reporte = ? AND id_usuario = ?
    `, [publicPath, id_reporte, userId]);

    if (info.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Reporte no encontrado' });
    }
    return res.json({ ok: true, path: publicPath });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo subir el comprobante' });
  }
});

// ===== POST: finalizar (registrar hora_fin y calcular hora_acumulada) =====
router.post('/reportes/finish', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id_reporte } = req.body;
    if (!id_reporte) {
      return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    // Set hora_fin = NOW() y calcular acumulada = hora_fin - hora_inicio
    const [info] = await db.query(`
      UPDATE reportes
      SET hora_fin = CURTIME(),
          hora_acumulada = SEC_TO_TIME(TIME_TO_SEC(TIMEDIFF(CURTIME(), hora_inicio)))
      WHERE id_reporte = ? AND id_usuario = ? AND hora_fin IS NULL
    `, [id_reporte, userId]);

    if (info.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Reporte no encontrado o ya finalizado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo finalizar el reporte' });
  }
});

// Crear solicitud de horas extra
// Requiere: req.session.user.id (requireAuth debe poblar la sesión)
router.post('/api/notificaciones', requireAuth, async (req, res) => {
  try {
    const id_usuario = req.session.user.id;
    let { fecha_solicitada, hora_inicio, hora_fin, motivo } = req.body;

    // Sanitización
    fecha_solicitada = String(fecha_solicitada||'').trim().slice(0, 10); // YYYY-MM-DD
    hora_inicio      = String(hora_inicio||'').trim().slice(0, 8);       // HH:MM o HH:MM:SS
    hora_fin         = String(hora_fin||'').trim().slice(0, 8);
    motivo           = String(motivo||'').trim().slice(0, 2000);

    // Validaciones simples
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_solicitada)) {
      return res.status(400).json({ ok:false, msg:'Fecha inválida (YYYY-MM-DD).' });
    }
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hora_inicio) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_fin)) {
      return res.status(400).json({ ok:false, msg:'Hora inválida (HH:MM).' });
    }
    // normaliza HH:MM a HH:MM:00
    if (hora_inicio.length === 5) hora_inicio += ':00';
    if (hora_fin.length === 5) hora_fin += ':00';
    if (hora_inicio >= hora_fin) {
      return res.status(400).json({ ok:false, msg:'La hora fin debe ser mayor que la hora inicio.' });
    }
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ ok:false, msg:'Motivo mínimo 5 caracteres.' });
    }

    // Insertar (estado=1 pendiente)
    const [result] = await db.query(
      `INSERT INTO notificaciones
         (id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, estado)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo]
    );

    // opcional: devolver la fila mínima creada
    res.json({
      ok: true,
      msg: 'Solicitud creada',
      notificacion: {
        id_notificacion: result.insertId,
        id_usuario,
        fecha_solicitada,
        hora_inicio,
        hora_fin,
        motivo,
        estado: 1
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error creando la solicitud' });
  }
});



const ExcelJS = require('exceljs');

router.get('/reportes/export', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Traer datos del usuario (para el título del archivo/hoja)
    const [urows] = await db.query(`
      SELECT id_usuario, nombre
      FROM usuarios
      WHERE id_usuario = ?
      LIMIT 1
    `, [userId]);
    if (!urows || urows.length === 0) {
      return res.status(404).send('Usuario no encontrado');
    }
    const usuario = urows[0];

    // Traer reportes SIN formatear (así controlamos fecha/hora en Excel)
    const [reports] = await db.query(`
      SELECT
        DATE_FORMAT(fecha, '%Y-%m-%d')          AS fecha,
        TIME_FORMAT(hora_acumulada, '%H:%i:%s') AS hora_acumulada,
        TIME_FORMAT(hora_inicio, '%H:%i:%s')    AS hora_inicio,
        TIME_FORMAT(hora_fin, '%H:%i:%s')       AS hora_fin,
        tarea, observacion
      FROM reportes
      WHERE id_usuario = ?
      ORDER BY fecha DESC, id_reporte DESC
    `, [userId]);

    // (Opcional) total acumulado para encabezado
    const [totals] = await db.query(`
      SELECT COALESCE(SEC_TO_TIME(SUM(TIME_TO_SEC(hora_acumulada))), '00:00:00') AS total_acumulada
      FROM reportes
      WHERE id_usuario = ?
    `, [userId]);
    const totalAcum = (totals && totals[0]) ? totals[0].total_acumulada : '00:00:00';

    // Helpers para convertir a tipos Excel
    const toExcelDate = (ymd) => {
      if (!ymd) return null; // deja celda vacía
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    };
    const toExcelTime = (hms) => {
      if (!hms) return null;
      const [h, m, s] = hms.split(':').map(x => parseInt(x || '0', 10));
      const secs = (h * 3600) + (m * 60) + (s || 0);
      return secs / 86400; // Excel: fracción del día
    };

    // Crear libro/hoja
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reportes');

    // Título y metadatos
    ws.mergeCells('A1:G1');
    ws.getCell('A1').value = `Reporte del estudiante: ${usuario.nombre}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { vertical: 'middle' };

    ws.mergeCells('A2:G2');
    ws.getCell('A2').value = `Exportado: ${new Date().toLocaleString()}  •  Total horas acumuladas: ${totalAcum}`;
    ws.getCell('A2').font = { italic: true, size: 11 };
    ws.getCell('A2').alignment = { vertical: 'middle' };

    // Encabezados
    ws.addRow([]);
    ws.addRow([
      'Fecha',
      'Hora acumulada',
      'Hora inicio',
      'Hora fin',
      'Tarea (descripción)',
      'Observaciones'
    ]);

    // Estilos de encabezado
    const headerRow = ws.getRow(ws.lastRow.number);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle' };
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });

    // Columnas (ancho + formatos)
    ws.columns = [
      { key: 'fecha', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
      { key: 'hora_acumulada', width: 14, style: { numFmt: 'hh:mm:ss' } },
      { key: 'hora_inicio', width: 12, style: { numFmt: 'hh:mm' } },
      { key: 'hora_fin', width: 12, style: { numFmt: 'hh:mm' } },
      { key: 'tarea', width: 40 },
      { key: 'observacion', width: 40 }
    ];

    // Datos
    if (!reports || reports.length === 0) {
      ws.addRow(['Sin registros', null, null, null, null, null, null]);
    } else {
      for (const r of reports) {
        ws.addRow({
          fecha: toExcelDate(r.fecha),
          hora_acumulada: toExcelTime(r.hora_acumulada),
          hora_inicio: toExcelTime(r.hora_inicio),
          hora_fin: toExcelTime(r.hora_fin),
          tarea: r.tarea || '',
          observacion: r.observacion || ''
        });
      }
    }

    // Bordes finos para el cuerpo
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

    // Freeze panes (fija filas 1-3: título, meta, encabezado)
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    // Nombre de archivo
    const safeName = String(usuario.nombre || 'usuario').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const ymd = new Date().toISOString().slice(0,10); // YYYY-MM-DD
    const filename = `reportes_${safeName}_${ymd}.xlsx`;

    // Enviar descarga
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo generar el Excel.');
  }
});


module.exports = router;
