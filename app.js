const express = require('express');
const path = require('path');
const app = express();
const session = require("express-session");

// Requerido por Vercel para manejar sesiones tras el proxy inverso
app.set('trust proxy', 1);

// Configuración del motor de vistas (EJS)
app.set('view engine', 'ejs');

app.set('views', path.join(__dirname, 'src', 'views'));

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

app.use('/public', express.static(path.join(process.cwd(), 'public'))); // si aún no lo tienes
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));


// Middleware para leer datos en JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.get('/hora', (req, res) => {
  res.send(`Hora del servidor: ${new Date().toString()}`);
});


// Sesiones
app.use(
  session({
    secret: "supersecreto", // cámbialo
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Debe estar en false si no usas HTTPS local o si estás probando con vercel dev
      maxAge: 1000 * 60 * 60 * 4
    }
  })
);


// ==========================================
// RUTAS
// ==========================================

// 1. General / Usuarios
const LoginRoutes = require('./src/routes/login');
app.use(LoginRoutes);

// Middleware para forzar cambio de contraseña
app.use((req, res, next) => {
  if (req.session && req.session.user && req.session.requiereCambioClave) {
    if (req.path !== '/cambiar-password' && req.path !== '/logout') {
      return res.redirect('/cambiar-password');
    }
  }
  next();
});

const DashboardRoutes = require('./src/routes/Dashboard');
app.use(DashboardRoutes);

const ReporteRoutes = require('./src/routes/reporte');
app.use(ReporteRoutes);

const CuentaRoutes = require('./src/routes/cuenta');
app.use(CuentaRoutes);

const notificacionesRoutes = require('./src/routes/notificaciones');
app.use(notificacionesRoutes);

const GeofenceRoutes = require('./src/routes/geofence');
app.use(GeofenceRoutes);

const TeletrabajoRoutes = require('./src/routes/teletrabajo');
app.use(TeletrabajoRoutes);

const pagina_webRoutes = require('./src/routes/pagina_web/pagina');
app.use(pagina_webRoutes);

// Rutas para asistencia de pasantes
const asistenciaPasantesRoutes = require('./src/routes/asistencia');
app.use(asistenciaPasantesRoutes);

const horarioPasantesRoutes = require('./src/routes/horario');
app.use(horarioPasantesRoutes);

// 2. Administración
const UsuarioRoutes = require('./src/routes/usuarios');
app.use(UsuarioRoutes);

const Reporte_adminRoutes = require('./src/routes/reporte_admin');
app.use(Reporte_adminRoutes);

const notificaciones_adminRoutes = require('./src/routes/notificaciones_admin');
app.use(notificaciones_adminRoutes);

const graficosRoutes = require('./src/routes/graficos');
app.use(graficosRoutes);

const pagina_webAdminRoutes = require('./src/routes/pagina_web/admin');
app.use(pagina_webAdminRoutes);

//3. LUGARES
const ObrasRoutes = require('./src/routes/obras');
app.use(ObrasRoutes);

// 4. Manejador de ruta 404 y Errores Globales
app.use((req, res, next) => {
  if (req.xhr || req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(404).json({ ok: false, msg: 'Ruta no encontrada' });
  }
  res.status(404).render('error', {
    statusCode: 404,
    statusLabel: 'Página no encontrada · 404',
    title: 'Página no encontrada',
    message: 'La página a la que intentas acceder no existe o fue reubicada.'
  });
});

app.use((err, req, res, next) => {
  console.error('Error no controlado en el servidor:', err);
  if (req.xhr || req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(500).json({ ok: false, msg: 'Error interno del servidor' });
  }
  res.status(500).render('error', {
    statusCode: 500,
    statusLabel: 'Error interno · 500',
    title: 'Error en el sistema',
    message: 'Ocurrió un error inesperado al procesar la solicitud en el servidor.'
  });
});

// Remplaza el app.listen final por esto:
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
