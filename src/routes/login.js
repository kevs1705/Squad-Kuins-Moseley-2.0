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
      WHERE CI = ? AND contrasena = ?
      LIMIT 1
    `;
    const [rows] = await db.query(sql, [ci, password]);

    if (!rows || rows.length === 0) {
      return res.render("login", {
        title: "Iniciar sesión",
        error: "CI o contraseña incorrectos."
      });
    }

    const user = rows[0];

    req.session.user = {
      id: user.id_usuario,
      nombre: user.nombre,
      ci: user.CI,
      rol: user.rol
    };

    // 👇 Redirección según rol
    if (user.rol === 1) {
      return res.redirect("/dashboard");
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

module.exports = router;
