const express = require('express');
const router = express.Router();
const db = require('../config/bd'); // mysql2/promise

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

// GET Perfil (incluye id_carrera, nombre de carrera y lista completa de carreras)
router.get('/cuenta', requireAuth, async (req, res) => {
  try {
    // 1. Obtener datos del usuario con JOIN a carreras
    const [rows] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.CI, u.universidad, u.id_carrera, 
              c.nombre AS carrera_nombre, u.celular, u.estado, u.contrasena, u.rol
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       WHERE u.id_usuario = ? LIMIT 1`,
      [req.session.user.id]
    );

    if (!rows.length) {
      return res.status(404).render('cuenta', { title: 'Perfil — MONSELEY', error: 'No se encontró el usuario' });
    }

    // 2. Obtener listado de carreras para el <select> del modal
    const [carreras] = await db.query(
      `SELECT id_carrera, nombre FROM carreras ORDER BY nombre ASC`
    );

    const u = rows[0];
    const estadoTexto = (u.estado === 1) ? 'Activo' : 'Inactivo';

    res.render('cuenta', { 
      title: 'Perfil — MONSELEY', 
      user: { ...u, estadoTexto },
      carreras 
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('cuenta', { title: 'Perfil — MONSELEY', error: 'Error al cargar el perfil' });
  }
});

// API Update: CI, nombre, universidad, id_carrera, celular, (opcional) contrasena
router.post('/api/cuenta/update', requireAuth, async (req, res) => {
  try {
    let { ci, nombre, universidad, id_carrera, celular, contrasena } = req.body;

    // Sanitización
    ci          = String(ci || '').trim().slice(0, 32);
    nombre      = String(nombre || '').trim().slice(0, 100);
    universidad = String(universidad || '').trim().slice(0, 120);
    id_carrera  = Number(id_carrera) || null;
    celular     = String(celular || '').trim().slice(0, 20);
    contrasena  = (contrasena == null) ? '' : String(contrasena).slice(0, 255);

    // Validaciones
    if (!ci || !/^[0-9.\-]{5,32}$/.test(ci)) {
      return res.status(400).json({ ok: false, msg: 'CI inválido (5–32, dígitos/punto/guion).' });
    }
    if (!nombre || nombre.length < 2) {
      return res.status(400).json({ ok: false, msg: 'Nombre obligatorio (2–100).' });
    }
    if (!universidad) {
      return res.status(400).json({ ok: false, msg: 'Universidad es obligatoria.' });
    }
    if (!id_carrera) {
      return res.status(400).json({ ok: false, msg: 'Debe seleccionar una carrera válida.' });
    }
    if (celular && !/^[0-9]{7,12}$/.test(celular)) {
      return res.status(400).json({ ok: false, msg: 'Celular debe tener 7–12 dígitos.' });
    }
    if (contrasena && contrasena.length < 4) {
      return res.status(400).json({ ok: false, msg: 'La contraseña debe tener mínimo 4 caracteres.' });
    }

    // Validar duplicado de CI
    const [dupes] = await db.query(
      'SELECT id_usuario FROM usuarios WHERE CI = ? AND id_usuario <> ? LIMIT 1',
      [ci, req.session.user.id]
    );
    if (dupes.length) {
      return res.status(409).json({ ok: false, msg: 'El CI ya se encuentra registrado por otro usuario.' });
    }

    // Construir UPDATE dinámico
    const fields = [
      'CI = ?',
      'nombre = ?',
      'universidad = ?',
      'id_carrera = ?',
      "celular = NULLIF(?, '')"
    ];
    const params = [ci, nombre, universidad, id_carrera, celular];

    if (contrasena) {
      fields.push('contrasena = ?');
      params.push(contrasena);
    }

    params.push(req.session.user.id);

    await db.query(
      `UPDATE usuarios
          SET ${fields.join(', ')}
        WHERE id_usuario = ?
        LIMIT 1`,
      params
    );

    // Sincronizar la sesión del servidor
    req.session.user.nombre = nombre;
    req.session.user.ci     = ci;

    return res.json({ ok: true, msg: 'Perfil actualizado correctamente' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error al guardar los datos del perfil' });
  }
});

module.exports = router;