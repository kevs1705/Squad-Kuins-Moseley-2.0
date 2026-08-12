// routes/graficos.js
const express = require("express");
const router = express.Router();
const db = require("../config/bd"); // mysql2/promise

// Vista
router.get('/graficos', async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT id_usuario, nombre FROM usuarios ORDER BY nombre`
    );
    const [kpi] = await db.query(
      `SELECT COUNT(*) AS total FROM usuarios WHERE rol = 0`
    );
    res.render('graficos', {
      users,
      totalPasantes: kpi?.[0]?.total || 0
    });
  } catch (e) {
    console.error('GET /graficos error:', e);
    res.render('graficos', { users: [], totalPasantes: 0 });
  }
});

/**
 * API: usuarios (para el <select>)
 */
router.get('/api/graficos/usuarios', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_usuario, nombre FROM usuarios ORDER BY nombre`
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Error cargando usuarios' });
  }
});

/**
 * API: lineal por usuario (horas por semana + acumuladas)
 * Params: userId
 */
router.get('/api/graficos/line', async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ ok: false, msg: 'userId requerido' });

    const [rows] = await db.query(`
      SELECT
        FLOOR(DATEDIFF(fecha, '2025-08-18') / 7) + 1 AS semana,
        MIN(fecha) AS semana_inicio,
        SUM(TIME_TO_SEC(hora_acumulada))/3600 AS horas_semana
      FROM reportes
      WHERE id_usuario = ?
      GROUP BY semana
      ORDER BY semana
    `, [userId]);

    // Calculamos acumulado en Node.js
    let acc = 0;
    const labels = rows.map(r => {
      const d = new Date(r.semana_inicio);
      return `Sem ${r.semana} · ${d.toISOString().slice(0,10)}`;
    });
    const horas = rows.map(r => {
      const val = Number(r.horas_semana || 0);
      acc += val;
      return val;
    });
    const acumulado = horas.map((h, i) => horas.slice(0, i+1).reduce((a,b) => a+b, 0));

    res.json({ ok: true, labels, horas, acumulado });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Error cargando series' });
  }
});

/**
 * API: pie (horas totales por pasante)
 */
router.get('/api/graficos/pie', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        u.id_usuario,
        u.nombre,
        COALESCE(SUM(TIME_TO_SEC(r.hora_acumulada))/3600, 0) AS horas
      FROM usuarios u
      LEFT JOIN reportes r ON r.id_usuario = u.id_usuario
      WHERE u.rol = 0
      GROUP BY u.id_usuario, u.nombre
      ORDER BY horas DESC, u.nombre ASC
    `);

    res.json({
    ok: true,
    labels: rows.map(r => r.nombre),
    data: rows.map(r => Number(r.horas || 0))  // <<<<<<
    });

  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Error cargando pastel' });
  }
});

/**
 * API: KPI total pasantes
 */
router.get('/api/graficos/kpi', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS total FROM usuarios WHERE rol = 0`
    );
    res.json({ ok: true, total: rows?.[0]?.total || 0 });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Error KPI' });
  }
});

module.exports = router;
