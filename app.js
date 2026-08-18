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

const DashboardRoutes = require('./src/routes/dashboard');
app.use(DashboardRoutes);

const ReporteRoutes = require('./src/routes/reporte');
app.use(ReporteRoutes);

const CuentaRoutes = require('./src/routes/cuenta');
app.use(CuentaRoutes);

const notificacionesRoutes = require('./src/routes/notificaciones');
app.use(notificacionesRoutes);

const GeofenceRoutes = require('./src/routes/geofence');
app.use(GeofenceRoutes);

const pagina_webRoutes = require('./src/routes/pagina_web/pagina');
app.use(pagina_webRoutes);


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

// Si tu archivo está dentro de src/routes/
const ObrasRoutes = require('./src/routes/obras');
app.use(ObrasRoutes);

// Remplaza el app.listen final por esto:
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
