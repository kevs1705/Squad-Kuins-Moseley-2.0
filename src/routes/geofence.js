const express = require('express');
const router = express.Router();
const db = require('../config/bd.js'); // Ajusta la ruta a tu conexión MySQL (pool/promise)
const { distanceMeters } = require('../middleware/geofence');
const { requireAuth } = require('../middleware/auth.js');

// GET: Cargar la vista de geocerca con los lugares activos
router.get('/geofence', requireAuth, async (req, res) => {
  const redirect = req.query.redirect || '/dashboard';

  try {
    // Obtener los lugares activos de la base de datos
    const [lugares] = await db.query(
      "SELECT id_lugar, nombre, latitud, longitud, radio_metros FROM lugares WHERE estado = 'ACTIVO'"
    );

    if (!lugares || lugares.length === 0) {
      return res.status(500).send('No hay lugares/obras activas configuradas en la base de datos.');
    }

    // Renderizar la vista pasando el listado de lugares
    res.render('geofence', { redirect, lugares });
  } catch (error) {
    console.error('Error al obtener lugares:', error);
    res.status(500).send('Error interno del servidor.');
  }
});

// POST API: Validar si las coordenadas del usuario coinciden con alguna obra/lugar activo
router.post('/api/geofence/verify', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, msg: 'Sesión no iniciada.' });
  }
  const { lat, lng, accuracy } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    return res.status(400).json({ ok: false, msg: 'Parámetros de ubicación inválidos' });
  }

  const hardMaxAccuracy = 200; // metros
  if (accuracy > hardMaxAccuracy) {
    return res.status(400).json({ ok: false, msg: `Señal GPS imprecisa (${Math.round(accuracy)}m).` });
  }

  try {
    // 1. Obtener lugares activos desde la base de datos
    const [lugares] = await db.query(
      "SELECT id_lugar, nombre, latitud, longitud, radio_metros FROM lugares WHERE estado = 'ACTIVO'"
    );

    if (!lugares || lugares.length === 0) {
      return res.status(400).json({ ok: false, msg: 'No existen ubicaciones activas autorizadas.' });
    }

    // 2. Verificar si el usuario está dentro del radio de ALGUNA de las obras/oficinas
    let lugarValido = null;
    let menorDistancia = Infinity;

    for (const lugar of lugares) {
      const latLugar = parseFloat(lugar.latitud);
      const lngLugar = parseFloat(lugar.longitud);
      const radioLugar = parseFloat(lugar.radio_metros);

      const dist = distanceMeters(latLugar, lngLugar, lat, lng);
      const dentro = dist <= radioLugar; // Validación estricta: distancia menor o igual al radio de la obra

      if (dentro) {
        lugarValido = { ...lugar, distanciaCalculada: dist };
        break; // Detener en la primera coincidencia válida
      }

      if (dist < menorDistancia) {
        menorDistancia = dist;
      }
    }

    // 3. Si no estuvo dentro de ningún lugar activo
    if (!lugarValido) {
      return res.status(403).json({
        ok: false,
        msg: `Fuera de zona autorizada. Distancia más cercana: ${Math.round(menorDistancia)}m.`
      });
    }

    // 4. Guardar pase en la sesión indicando el lugar donde se validó
    req.session.geofence = {
      ok: true,
      until: Date.now() + (8 * 60 * 60 * 1000), // Válido por 8 horas
      id_lugar: lugarValido.id_lugar,
      nombre_lugar: lugarValido.nombre,
      lat,
      lng,
      accuracy: Math.round(accuracy),
      distance: Math.round(lugarValido.distanciaCalculada)
    };

    req.session.save((err) => {
      if (err) {
        console.error('Error al guardar sesión de geocerca:', err);
        return res.status(500).json({ ok: false, msg: 'No se pudo guardar la sesión.' });
      }

      return res.json({
        ok: true,
        msg: `Ubicación verificada en "${lugarValido.nombre}"`,
        lugar: lugarValido.nombre,
        distanceM: Math.round(lugarValido.distanciaCalculada),
        accuracyM: Math.round(accuracy)
      });
    });

  } catch (error) {
    console.error('Error en verificación de geocerca:', error);
    return res.status(500).json({ ok: false, msg: 'Error de base de datos.' });
  }
});

// POST API: Registrar la Entrada/Salida en la tabla asistencias
router.post('/api/geofence/register', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, msg: 'Sesión no iniciada.' });
  }

  const { tipo } = req.body;
  if (tipo !== 'entrada' && tipo !== 'salida') {
    return res.status(400).json({ ok: false, msg: 'Tipo de asistencia inválido.' });
  }

  // Verificar que la geocerca haya sido validada en esta sesión y no haya expirado
  if (!req.session.geofence || !req.session.geofence.ok || Date.now() > req.session.geofence.until) {
    return res.status(403).json({ ok: false, msg: 'Ubicación no verificada o sesión de ubicación expirada.' });
  }

  const userId = req.session.user.id || req.session.user.id_usuario;
  const idLugar = req.session.geofence.id_lugar;

  try {
    // Buscar si ya existe una asistencia para hoy
    const [existing] = await db.query(
      'SELECT id_asistencia, hora_entrada, hora_salida FROM asistencias WHERE id_usuario = ? AND fecha = CURDATE() LIMIT 1',
      [userId]
    );

    if (existing && existing.length > 0) {
      const record = existing[0];
      if (tipo === 'entrada') {
        await db.query(
          'UPDATE asistencias SET hora_entrada = CURTIME(), id_lugar = ? WHERE id_asistencia = ?',
          [idLugar, record.id_asistencia]
        );
      } else {
        await db.query(
          'UPDATE asistencias SET hora_salida = CURTIME(), id_lugar = ? WHERE id_asistencia = ?',
          [idLugar, record.id_asistencia]
        );
      }
    } else {
      // No existe, insertar un nuevo registro
      if (tipo === 'entrada') {
        await db.query(
          'INSERT INTO asistencias (id_usuario, id_lugar, fecha, hora_entrada, estado) VALUES (?, ?, CURDATE(), CURTIME(), ?)',
          [userId, idLugar, 'PRESENTE']
        );
      } else {
        await db.query(
          'INSERT INTO asistencias (id_usuario, id_lugar, fecha, hora_salida, estado) VALUES (?, ?, CURDATE(), CURTIME(), ?)',
          [userId, idLugar, 'PRESENTE']
        );
      }
    }

    // Obtener la hora actual registrada
    const [[{ server_time }]] = await db.query("SELECT TIME_FORMAT(CURTIME(), '%H:%i:%s') AS server_time");

    return res.json({
      ok: true,
      msg: `Se registró tu ${tipo} con éxito.`,
      hora: server_time
    });

  } catch (error) {
    console.error('Error al registrar asistencia en BD:', error);
    return res.status(500).json({ ok: false, msg: 'Error al guardar la asistencia en la base de datos.' });
  }
});

module.exports = router;