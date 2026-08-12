// routes/geofence.js
const express = require('express');
const router = express.Router();
const { OFFICE, distanceMeters } = require('../middleware/geofence');

// Vista que pide ubicación (solo geocerca)
router.get('/geofence', (req, res) => {
  const redirect = req.query.redirect || '/dashboard';
  res.render('geofence', { redirect, office: OFFICE });
});

// API: validar ubicación
router.post('/api/geofence/verify', (req, res) => {
  const { lat, lng, accuracy } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    return res.status(400).json({ ok: false, msg: 'Parámetros inválidos' });
  }

  const hardMaxAccuracy = 200; // metros
  if (accuracy > hardMaxAccuracy) {
    return res.status(400).json({ ok: false, msg: `Señal GPS imprecisa (${Math.round(accuracy)}m).` });
  }

  const d = distanceMeters(OFFICE.lat, OFFICE.lng, lat, lng);
  const dentro = (d - accuracy) <= OFFICE.radiusM;

  if (!dentro) {
    return res.status(403).json({
      ok: false,
      msg: `Fuera de zona (dist=${Math.round(d)}m, prec=${Math.round(accuracy)}m).`
    });
  }

  // ✅ Marcar la sesión como verificada por geolocalización
  req.session.geo = {
    verified: true,
    ts: Date.now(),
    lat,
    lng,
    accuracy: Math.round(accuracy),
    distance: Math.round(d)
  };

  // Guardar la sesión antes de responder
  req.session.save((err) => {
    if (err) {
      console.error('Error guardando sesión geo:', err);
      return res.status(500).json({ ok: false, msg: 'No se pudo guardar la sesión.' });
    }
    return res.json({
      ok: true,
      msg: 'Validación OK',
      distanceM: Math.round(d),
      accuracyM: Math.round(accuracy)
    });
  });
});

module.exports = router;
