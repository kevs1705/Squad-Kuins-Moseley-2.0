// routes/dashboard.js (o donde tengas este router)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// ===== Middleware: exige geolocalización previa =====
function requireGeo({ maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  return (req, res, next) => {
    // Admins (rol 1) no requieren geolocalizaciÓN
    if (req.session?.user?.rol === 1) return next();

    const geo = req.session?.geo;
    if (!geo?.verified) {
      // No verificado aún → manda a geofence con redirect de vuelta
      const redirect = encodeURIComponent(req.originalUrl || '/dashboard');
      return res.redirect(`/geofence?redirect=${redirect}`);
    }
    // Expirado
    if (Date.now() - geo.ts > maxAgeMs) {
      // Limpia y pide verificar de nuevo
      req.session.geo = null;
      const redirect = encodeURIComponent(req.originalUrl || '/dashboard');
      return res.redirect(`/geofence?redirect=${redirect}`);
    }
    next();
  };
}

// Dashboard (solo si pasó geocerca)
router.get('/dashboard', requireAuth, requireGeo(), (req, res) => {
  res.redirect('/cuenta');
});

// Logout (simple)
router.get('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
