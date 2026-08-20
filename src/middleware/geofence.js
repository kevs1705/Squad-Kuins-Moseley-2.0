// Cálculo de distancia mediante fórmula Haversine (en metros)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Middleware: Exige que la sesión contenga una verificación de geocerca válida
function requireGeofence(req, res, next) {
  // Los Administradores (rol = 1) se omiten si se prefiere
  if (req.session?.user?.rol === 1) return next();

  const g = req.session?.geofence;
  const now = Date.now();

  if (g && g.ok && g.until > now) {
    return next();
  }

  // Redirigir a la vista de geocerca si la sesión caducó o no ha sido verificada
  return res.redirect(`/geofence?redirect=${encodeURIComponent(req.originalUrl)}`);
}

module.exports = {
  distanceMeters,
  requireGeofence
};