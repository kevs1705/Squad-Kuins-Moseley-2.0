// routes/login.js
const express = require("express");
const router = express.Router();
const db = require("../config/bd"); // mysql2/promise

// GET login
router.get("/login", (req, res) => {
  res.render("login", { title: "Iniciar sesión" });
});

// POST login
router.post("/login", async (req, res) => {
  try {
    const { ci, password } = req.body;

    if (!ci || !password) {
      return res.render("login", {
        title: "Iniciar sesión",
        error: "Debes ingresar CI y contraseña."
      });
    }

    const sql = `
      SELECT id_usuario, nombre, CI, contrasena, rol
      FROM usuarios
      WHERE CI = ?
      LIMIT 1
    `;
    const [rows] = await db.query(sql, [ci]);

    if (!rows || rows.length === 0) {
      return res.render("login", {
        title: "Iniciar sesión",
        error: "CI o contraseña incorrectos."
      });
    }

    const user = rows[0];

    // Validación de la contraseña
    if (user.contrasena !== password) {
      return res.render("login", {
        title: "Iniciar sesión",
        error: "CI o contraseña incorrectos."
      });
    }

    req.session.user = {
      id: user.id_usuario,
      nombre: user.nombre,
      ci: user.CI,
      rol: user.rol
    };

    // 👇 Redirección según rol y comprobación de primer inicio
    if (password === '12345678') {
      req.session.requiereCambioClave = true;
      return res.redirect("/cambiar-password");
    } else {
      return res.redirect("/dashboard");
    }

  } catch (err) {
    console.error("DB Error:", err);
    return res.render("login", {
      title: "Iniciar sesión",
      error: "Error en la base de datos."
    });
  }
});

// GET /cambiar-password
router.get("/cambiar-password", (req, res) => {
  if (!req.session.user || !req.session.requiereCambioClave) {
    return res.redirect("/dashboard");
  }
  res.render("cambiar_password", { title: "Cambiar Contraseña" });
});

// POST /cambiar-password
router.post("/cambiar-password", async (req, res) => {
  if (!req.session.user || !req.session.requiereCambioClave) {
    return res.redirect("/login");
  }

  const { password, confirm_password } = req.body;

  if (!password || password !== confirm_password || password === '12345678') {
    return res.render("cambiar_password", {
      title: "Cambiar Contraseña",
      error: "Datos inválidos o contraseñas no coinciden."
    });
  }

  if (password.length < 6 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    return res.render("cambiar_password", {
      title: "Cambiar Contraseña",
      error: "La contraseña debe tener al menos 6 caracteres e incluir letras, números y al menos un carácter especial (ej. @, #, $, *, !, .)."
    });
  }

  try {
    const userId = req.session.user.id;
    
    // 1. Update in DB
    await db.query(
      `UPDATE usuarios SET contrasena = ? WHERE id_usuario = ? LIMIT 1`,
      [password, userId]
    );

    // 2. Update Biometric (ZKTeco K14)
    let Zkteco = null;
    if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
      try {
        Zkteco = require('zkteco-js-with-restart');
      } catch (error) {}
    }

    if (Zkteco) {
      try {
        const [rows] = await db.query('SELECT nombre, id_carrera, rol FROM usuarios WHERE id_usuario=?', [userId]);
        if (rows.length > 0) {
          const userDB = rows[0];
          const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.1.250';
          const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;
          
          const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
          await dispositivoZk.createSocket();
          
          const rolBiometrico = userDB.rol === 1 ? 14 : 0;
          const deptoBiometrico = userDB.id_carrera ? Number(userDB.id_carrera) : 1;

          await dispositivoZk.setUser(
            Number(userId),
            String(userId),
            userDB.nombre.slice(0, 24),
            String(password),
            rolBiometrico,
            0,
            deptoBiometrico
          );
          await dispositivoZk.disconnect();
          console.log(`🚀 Contraseña de [${userDB.nombre}] actualizada en el biométrico.`);
        }
      } catch (bioError) {
        console.error('⚠️ BD actualizada, pero falló sincronización con biométrico:', bioError.message);
      }
    }

    // Remove the flag
    delete req.session.requiereCambioClave;
    
    return res.redirect("/dashboard");

  } catch (err) {
    console.error("Error al cambiar contraseña:", err);
    return res.render("cambiar_password", {
      title: "Cambiar Contraseña",
      error: "Error interno del servidor."
    });
  }
});

module.exports = router;
