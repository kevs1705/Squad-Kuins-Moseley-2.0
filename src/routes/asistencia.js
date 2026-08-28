const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const multer = require('multer');

/* ==========================================================================
   GET: VISTA PRINCIPAL DE ASISTENCIA (PANEL DE ESTADO E HISTORIAL)
   ========================================================================== */
router.get('/usuario/asistencia', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    // 1. Datos del usuario autenticado
    const [users] = await db.query(
      'SELECT id_usuario, nombre, CI, rol FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [userId]
    );

    if (users.length === 0) return res.status(404).send('Usuario no encontrado');
    const userDB = users[0];

    // 2. Horas totales acumuladas
    const [totals] = await db.query(`
      SELECT COALESCE(
        SUM(
          TIMESTAMPDIFF(
            SECOND,
            TIMESTAMP(fecha, COALESCE(NULLIF(TRIM(hora_entrada), ''), TIME(fecha_hora_biometrico_entrada))),
            TIMESTAMP(fecha, COALESCE(NULLIF(TRIM(hora_salida), ''), TIME(fecha_hora_biometrico_salida)))
          )
        ), 0
      ) AS total_segundos
      FROM asistencias
      WHERE id_usuario = ?
        AND COALESCE(NULLIF(TRIM(hora_entrada), ''), TIME(fecha_hora_biometrico_entrada)) IS NOT NULL
        AND COALESCE(NULLIF(TRIM(hora_salida), ''), TIME(fecha_hora_biometrico_salida)) IS NOT NULL
    `, [userId]);

    const total_acumulada = formatSecondsToHHMMSS(totals[0]?.total_segundos || 0);

    // 3. Verificar si el usuario tiene una jornada activa hoy (entrada sin salida)
    const [jornadaActiva] = await db.query(`
      SELECT 
        a.id_asistencia, 
        l.nombre AS lugar_nombre,
        TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada)), '%H:%i') AS hora_entrada
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      WHERE a.id_usuario = ? 
        AND a.fecha = CURDATE() 
        AND COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)) IS NULL
      LIMIT 1
    `, [userId]);

    // 4. Historial completo de asistencias unificado
    const [asistencias] = await db.query(`
      SELECT 
        a.id_asistencia,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        l.nombre AS lugar_nombre,
        l.tipo AS lugar_tipo,
        
        -- Entrada y Salida unificadas
        TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada)), '%H:%i') AS hora_entrada,
        TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)), '%H:%i') AS hora_salida,
        
        TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada)), '%H:%i:%s') AS bio_entrada,
        TIME_FORMAT(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)), '%H:%i:%s') AS bio_salida,

        IF(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)) IS NOT NULL, 
           TIME_FORMAT(TIMEDIFF(COALESCE(NULLIF(TRIM(a.hora_salida), ''), TIME(a.fecha_hora_biometrico_salida)), COALESCE(NULLIF(TRIM(a.hora_entrada), ''), TIME(a.fecha_hora_biometrico_entrada))), '%H:%i'), 
           'En curso'
        ) AS horas_dia,
        a.estado
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      WHERE a.id_usuario = ?
      ORDER BY a.fecha DESC, a.id_asistencia DESC
    `, [userId]);
// Renderizado de la vista
res.render('usuario/asistencia', {
  user: {
    id: userDB.id_usuario,
    nombre: userDB.nombre,
    ci: userDB.CI,
    rol: userDB.rol
  },
  total_acumulada, // Pasar la constante procesada directamente
  jornadaActiva: jornadaActiva[0] || null,
  asistencias
});

  } catch (e) {
    console.error(e);
    res.status(500).send('Error consultando el módulo de asistencia');
  }
});

function formatSecondsToHHMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

module.exports = router;