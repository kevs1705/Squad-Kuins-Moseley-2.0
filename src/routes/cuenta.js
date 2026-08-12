const express = require('express');
const router = express.Router();
const db = require('../config/bd'); // mysql2/promise

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

// GET Perfil (incluye contrasena para mostrarla)
router.get('/cuenta', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_usuario, nombre, CI, universidad, carrera, celular, estado, contrasena, rol
       FROM usuarios
       WHERE id_usuario = ? LIMIT 1`,
      [req.session.user.id]
    );
    if (!rows.length) {
      return res.status(404).render('cuenta', { title:'Perfil — MONSELEY', error:'No se encontró el usuario' });
    }
    const u = rows[0];
    const estadoTexto = (u.estado === 1) ? 'Activo' : 'Inactivo';
    res.render('cuenta', { title:'Perfil — MONSELEY', user: { ...u, estadoTexto } });
  } catch (e) {
    console.error(e);
    res.status(500).render('cuenta', { title:'Perfil — MONSELEY', error:'Error al cargar el perfil' });
  }
});
// API Update: CI, nombre, universidad, carrera, celular, (opcional) contrasena
router.post('/api/cuenta/update', requireAuth, async (req, res) => {
  try {
    let { ci, nombre, universidad, carrera, celular, contrasena } = req.body;

    // Sanitización
    ci           = String(ci || '').trim().slice(0, 32);
    nombre       = String(nombre || '').trim().slice(0, 100);
    universidad  = String(universidad || '').trim().slice(0, 120);
    carrera      = String(carrera || '').trim().slice(0, 120);
    celular      = String(celular || '').trim().slice(0, 20);
    // Contraseña opcional en texto plano (sin hash)
    contrasena   = (contrasena == null) ? '' : String(contrasena).slice(0, 255);

    // Validaciones simples
    if (!ci || !/^[0-9.\-]{5,32}$/.test(ci)) {
      return res.status(400).json({ ok:false, msg:'CI inválido (5–32, dígitos/punto/guion).' });
    }
    if (!nombre || nombre.length < 2) {
      return res.status(400).json({ ok:false, msg:'Nombre obligatorio (2–100).' });
    }
    if (!universidad) {
      return res.status(400).json({ ok:false, msg:'Universidad es obligatoria.' });
    }
    if (!carrera) {
      return res.status(400).json({ ok:false, msg:'Carrera es obligatoria.' });
    }
    if (celular && !/^[0-9]{7,12}$/.test(celular)) {
      return res.status(400).json({ ok:false, msg:'Celular debe tener 7–12 dígitos.' });
    }
    // Si decide cambiar contraseña, valida mínimo 4 (ajusta a tu gusto)
    if (contrasena && contrasena.length < 4) {
      return res.status(400).json({ ok:false, msg:'La contraseña debe tener mínimo 4 caracteres.' });
    }

    // Construir UPDATE dinámico según si envió contraseña
    const fields = [
      'CI = ?',
      'nombre = ?',
      'universidad = ?',
      'carrera = ?',
      "celular = NULLIF(?, '')"
    ];
    const params = [ci, nombre, universidad, carrera, celular];

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

    // Actualiza también la sesión para nombre/CI
    req.session.user.nombre = nombre;
    req.session.user.ci     = ci;

    return res.json({ ok:true, msg:'Actualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error al guardar' });
  }
});


module.exports = router;
