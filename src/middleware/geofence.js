
const OFFICE = {
 lat: -16.491805,   
 lng: -68.138944,  
 radiusM: 120       
};


// Haversine (metros)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Middleware: exige que la sesión tenga geofence válido
function requireGeofence(req, res, next) {
  // Admins (rol 1) no requieren geofence
  if (req.session?.user?.rol === 1) return next();

  const g = req.session?.geofence;
  const now = Date.now();
  if (g && g.ok && g.until > now) return next();

  // Si no tiene pase válido, lo mandamos a la pantalla de verificación
  return res.redirect(`/geofence?redirect=${encodeURIComponent(req.originalUrl)}`);
}

module.exports = {
  OFFICE,
  distanceMeters,
  requireGeofence
};
