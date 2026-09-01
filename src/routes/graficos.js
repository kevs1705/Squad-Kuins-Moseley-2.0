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
        YEARWEEK(a.fecha, 1) AS semana_key,
        MIN(a.fecha) AS semana_inicio,
        COALESCE(
          SUM(
            IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
               TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
               0)
          ), 0
        ) / 3600 AS horas_semana
      FROM asistencias a
      WHERE a.id_usuario = ? AND a.estado != 'ANULADO'
      GROUP BY semana_key
      ORDER BY semana_key ASC
    `, [userId]);

    // Calculamos acumulado en Node.js
    let acc = 0;
    const labels = rows.map((r, i) => {
      const d = r.semana_inicio ? new Date(r.semana_inicio) : new Date();
      return `Sem ${i + 1} · ${d.toISOString().slice(0,10)}`;
    });
    const horas = rows.map(r => {
      const val = Math.round(Number(r.horas_semana || 0) * 10) / 10;
      acc += val;
      return val;
    });
    const acumulado = horas.map((h, i) => Math.round(horas.slice(0, i+1).reduce((a,b) => a+b, 0) * 10) / 10);

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
        COALESCE(
          SUM(
            IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
               TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
               0)
          ), 0
        ) / 3600 AS horas
      FROM usuarios u
      LEFT JOIN asistencias a ON a.id_usuario = u.id_usuario AND a.estado != 'ANULADO'
      WHERE u.rol = 0
      GROUP BY u.id_usuario, u.nombre
      ORDER BY horas DESC, u.nombre ASC
    `);

    res.json({
      ok: true,
      labels: rows.map(r => r.nombre),
      data: rows.map(r => Math.round(Number(r.horas || 0) * 10) / 10)
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
