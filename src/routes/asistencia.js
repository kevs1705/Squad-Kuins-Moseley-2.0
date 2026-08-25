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
    SEC_TO_TIME(
      SUM(
        TIMESTAMPDIFF(
          SECOND,
          TIMESTAMP(
            fecha, 
            COALESCE(
              NULLIF(TRIM(hora_entrada), ''), 
              TIME(fecha_hora_biometrico_entrada)
            )
          ),
          CASE 
            WHEN hora_salida IS NOT NULL AND TRIM(hora_salida) NOT IN ('', '-') THEN 
              TIMESTAMP(fecha, TRIM(hora_salida))
            WHEN fecha_hora_biometrico_salida IS NOT NULL THEN 
              fecha_hora_biometrico_salida
            ELSE NULL
          END
        )
      )
    ), '00:00:00'
  ) AS total_acumulada
  FROM asistencias
  WHERE id_usuario = ?
    AND (
      (hora_entrada IS NOT NULL AND TRIM(hora_entrada) NOT IN ('', '-')) OR
      (fecha_hora_biometrico_entrada IS NOT NULL)
    )
    AND (
      (hora_salida IS NOT NULL AND TRIM(hora_salida) NOT IN ('', '-')) OR
      (fecha_hora_biometrico_salida IS NOT NULL)
    )
`, [userId]);

   const total_acumulada = totals[0]?.total_acumulada ? String(totals[0].total_acumulada) : '00:00:00';

    // 3. Verificar si el usuario tiene una jornada activa hoy (entrada sin salida)
    const [jornadaActiva] = await db.query(`
      SELECT 
        a.id_asistencia, 
        l.nombre AS lugar_nombre,
        TIME_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada
      FROM asistencias a
      LEFT JOIN lugares l ON a.id_lugar = l.id_lugar
      WHERE a.id_usuario = ? AND a.fecha = CURDATE() AND a.hora_salida IS NULL
      LIMIT 1
    `, [userId]);

    // 4. Historial completo de asistencias
    const [asistencias] = await db.query(`
      SELECT 
        a.id_asistencia,
        DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
        l.nombre AS lugar_nombre,
        l.tipo AS lugar_tipo,
        
        -- Entrada (Prioridad Biométrico > App)
        TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_entrada), a.hora_entrada), '%H:%i') AS hora_entrada,
        
        -- Salida (Prioridad Biométrico > App)
        TIME_FORMAT(COALESCE(TIME(a.fecha_hora_biometrico_salida), a.hora_salida), '%H:%i') AS hora_salida,
        
        TIME_FORMAT(a.fecha_hora_biometrico_entrada, '%H:%i:%s') AS bio_entrada,
        TIME_FORMAT(a.fecha_hora_biometrico_salida, '%H:%i:%s') AS bio_salida,

        IF(a.hora_salida IS NOT NULL, TIME_FORMAT(TIMEDIFF(a.hora_salida, a.hora_entrada), '%H:%i'), 'En curso') AS horas_dia,
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

module.exports = router;