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

    // 2. Total acumulado de horas (Calculado desde asistencias)
    const [totals] = await db.query(`
      SELECT COALESCE(
        SEC_TO_TIME(SUM(TIME_TO_SEC(TIMEDIFF(hora_salida, hora_entrada)))), 
        '00:00:00'
      ) AS total_acumulada
      FROM asistencias
      WHERE id_usuario = ? AND hora_salida IS NOT NULL
    `, [userId]);

    const total_acumulada = totals[0].total_acumulada;

    // 3. JORNADAS UNIFICADAS: Asistencias vinculadas a Reportes por FK (id_asistencia)
    const [jornadas] = await db.query(`
      SELECT 
        a.id_asistencia,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        a.estado AS asistencia_estado,
        l.nombre AS lugar_nombre,
        l.tipo AS lugar_tipo,
        
        -- Entrada y Salida (Biométrico o Marcación Manual)
        TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_entrada), a.hora_entrada), '%H:%i') AS hora_entrada,
        TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_salida), a.hora_salida), '%H:%i') AS hora_salida,
        
        TIME_FORMAT(a.fecha_hora_biometrico_entrada, '%H:%i:%s') AS bio_entrada,
        TIME_FORMAT(a.fecha_hora_biometrico_salida, '%H:%i:%s') AS bio_salida,

        -- Horas calculadas de la asistencia
        IF(a.hora_salida IS NOT NULL, TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i'), 'En curso') AS horas_dia,

        -- Datos del Reporte de la jornada
        r.id_reporte,
        r.tarea,
        r.comprobante,
        r.observacion
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      LEFT JOIN reportes r ON a.id_asistencia = r.id_asistencia
      WHERE a.id_usuario = ?
      ORDER BY a.fecha DESC, a.id_asistencia DESC
    `, [userId]);

    const user = {
      id: userDB.id_usuario,
      nombre: userDB.nombre,
      ci: userDB.CI,
      rol: userDB.rol
    };

    res.render('usuario/reporte', {
      user,
      total_acumulada,
      jornadas
    });

  } catch (e) {
    console.error(e);
    res.status(500).send('Error consultando la base de datos');
  }
});

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

// POST: Registrar o Actualizar Bitácora (Tarea + Comprobante)
router.post('/reportes/guardar', requireAuth, upload.single('comprobante'), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id_asistencia, tarea } = req.body;

    if (!id_asistencia || !tarea) {
      return res.status(400).json({ ok: false, error: 'Debe seleccionar una asistencia y describir la tarea.' });
    }

    const publicPath = req.file ? '/uploads/comprobantes/' + req.file.filename : null;

    // Verificar si ya existe un reporte para esta asistencia
    const reporteExistente = await getReportePorAsistencia(id_asistencia, userId);

    if (reporteExistente) {
      // Actualizar reporte existente
      const imgFinal = publicPath || reporteExistente.comprobante;
      await db.query(`
        UPDATE reportes
        SET tarea = ?, comprobante = ?
        WHERE id_reporte = ? AND id_usuario = ?
      `, [tarea, imgFinal, reporteExistente.id_reporte, userId]);

      return res.json({ ok: true, msg: 'Bitácora actualizada con éxito' });
    } else {
      // Obtener la fecha de la asistencia seleccionada
      const [[asistencia]] = await db.query(
        'SELECT fecha FROM asistencias WHERE id_asistencia = ? AND id_usuario = ?',
        [id_asistencia, userId]
      );

      if (!asistencia) {
        return res.status(404).json({ ok: false, error: 'Asistencia no encontrada' });
      }

      // Crear nuevo reporte asociado a la asistencia
      await db.query(`
        INSERT INTO reportes (id_usuario, id_asistencia, fecha, tarea, comprobante)
        VALUES (?, ?, ?, ?, ?)
      `, [userId, id_asistencia, asistencia.fecha, tarea, publicPath]);

      return res.json({ ok: true, msg: 'Bitácora creada con éxito' });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la bitácora de trabajo' });
  }
});

/* ==========================================================================
   SOLICITUD DE NOTIFICACIONES / HORAS EXTRA
   ========================================================================== */
router.post('/api/notificaciones', requireAuth, async (req, res) => {
  try {
    const id_usuario = req.session.user.id;
    let { fecha_solicitada, hora_inicio, hora_fin, motivo } = req.body;

    fecha_solicitada = String(fecha_solicitada || '').trim().slice(0, 10);
    hora_inicio = String(hora_inicio || '').trim().slice(0, 8);
    hora_fin = String(hora_fin || '').trim().slice(0, 8);
    motivo = String(motivo || '').trim().slice(0, 2000);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_solicitada)) {
      return res.status(400).json({ ok: false, msg: 'Fecha inválida (YYYY-MM-DD).' });
    }
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hora_inicio) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_fin)) {
      return res.status(400).json({ ok: false, msg: 'Hora inválida (HH:MM).' });
    }

    if (hora_inicio.length === 5) hora_inicio += ':00';
    if (hora_fin.length === 5) hora_fin += ':00';

    if (hora_inicio >= hora_fin) {
      return res.status(400).json({ ok: false, msg: 'La hora fin debe ser mayor que la hora inicio.' });
    }
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ ok: false, msg: 'Motivo mínimo 5 caracteres.' });
    }

    const [result] = await db.query(
      `INSERT INTO notificaciones (id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, estado)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo]
    );

    res.json({
      ok: true,
      msg: 'Solicitud creada con éxito',
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
    res.status(500).json({ ok: false, msg: 'Error creando la solicitud' });
  }
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

    // Consulta unificada uniendo asistencias con reportes
    const [reports] = await db.query(`
      SELECT
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        l.nombre AS lugar,
        TIME_FORMAT(a.hora_entrada, '%H:%i:%s') AS hora_entrada,
        TIME_FORMAT(a.hora_salida, '%H:%i:%s') AS hora_salida,
        IF(a.hora_salida IS NOT NULL, TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i:%s'), '00:00:00') AS horas_trabajadas,
        r.tarea, 
        r.observacion
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      LEFT JOIN reportes r ON a.id_asistencia = r.id_asistencia
      WHERE a.id_usuario = ?
      ORDER BY a.fecha DESC
    `, [userId]);

    const [totals] = await db.query(`
      SELECT COALESCE(SEC_TO_TIME(SUM(TIME_TO_SEC(TIMEDIFF(hora_salida, hora_entrada)))), '00:00:00') AS total_acumulada
      FROM asistencias
      WHERE id_usuario = ? AND hora_salida IS NOT NULL
    `, [userId]);
    const totalAcum = (totals && totals[0]) ? totals[0].total_acumulada : '00:00:00';

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