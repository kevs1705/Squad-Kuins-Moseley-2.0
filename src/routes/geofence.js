const express = require('express');
const router = express.Router();
const db = require('../config/bd.js'); // Ajusta la ruta a tu conexión MySQL (pool/promise)
const { distanceMeters } = require('../middleware/geofence');

// GET: Cargar la vista de geocerca con los lugares activos
router.get('/geofence', async (req, res) => {
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
      'SELECT id_lugar, nombre, latitud, longitud, radio_metros FROM lugares WHERE estado = "ACTIVO"'
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
      const dentro = (dist - accuracy) <= radioLugar;

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

module.exports = router;