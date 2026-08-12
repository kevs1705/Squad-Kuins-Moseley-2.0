// routes/usuarios.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd'); // mysql2/promise

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}
// Opcional: solo admin
function requireAdmin(req, res, next) {
  // if (req.session.user.rol !== 1) return res.status(403).send('No autorizado');
  next();
}

// LISTA
router.get('/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT id_usuario, nombre, CI, universidad, carrera, celular, estado, rol, contrasena
     FROM usuarios ORDER BY id_usuario DESC`
  );
  res.render('usuarios', { title: 'Usuarios — MONSELEY', users: rows, user: req.session.user });
});

// CREAR
router.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    let { nombre, CI, universidad, carrera, celular, estado, rol, contrasena } = req.body;

    nombre = String(nombre||'').trim().slice(0,100);
    CI = String(CI||'').trim().slice(0,32);
    universidad = String(universidad||'').trim().slice(0,120);
    carrera = String(carrera||'').trim().slice(0,120);
    celular = String(celular||'').trim().slice(0,20);
    estado = Number(estado) ? 1 : 0;
    rol = Number(rol) ? 1 : 0;
    contrasena = String(contrasena||'').slice(0,255);

    if (!nombre || !CI || !universidad || !carrera || !contrasena) {
      return res.status(400).json({ ok:false, msg:'Campos obligatorios: nombre, CI, universidad, carrera, contraseña' });
    }
    if (!/^[0-9.\-]{5,32}$/.test(CI)) {
      return res.status(400).json({ ok:false, msg:'CI inválido (5–32, dígitos/punto/guion)' });
    }

    // (opcional) validar CI único
    const [dupes] = await db.query('SELECT id_usuario FROM usuarios WHERE CI=? LIMIT 1', [CI]);
    if (dupes.length) return res.status(409).json({ ok:false, msg:'CI ya registrado' });

    const [result] = await db.query(
      `INSERT INTO usuarios (nombre, CI, universidad, carrera, celular, estado, contrasena, rol)
       VALUES (?,?,?,?,?, ?, ?, ?)`,
      [nombre, CI, universidad, carrera, celular || null, estado, contrasena, rol]
    );

    const [rows] = await db.query(
      `SELECT id_usuario, nombre, CI, universidad, carrera, celular, estado, rol, contrasena
       FROM usuarios WHERE id_usuario=? LIMIT 1`, [result.insertId]
    );
    res.json({ ok:true, user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error creando usuario' });
  }
});
// EDITAR
router.post('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok:false, msg:'ID inválido' });

    let { nombre, CI, universidad, carrera, celular, estado, rol, contrasena } = req.body;

    nombre = String(nombre||'').trim().slice(0,100);
    CI = String(CI||'').trim().slice(0,32);
    universidad = String(universidad||'').trim().slice(0,120);
    carrera = String(carrera||'').trim().slice(0,120);
    celular = String(celular||'').trim().slice(0,20);
    estado = Number(estado) ? 1 : 0;
    rol = Number(rol) ? 1 : 0;
    contrasena = (contrasena==null) ? '' : String(contrasena).slice(0,255);

    if (!nombre || !CI || !universidad || !carrera) {
      return res.status(400).json({ ok:false, msg:'Campos obligatorios: nombre, CI, universidad, carrera' });
    }
    if (!/^[0-9.\-]{5,32}$/.test(CI)) {
      return res.status(400).json({ ok:false, msg:'CI inválido' });
    }

    const [dupes] = await db.query('SELECT id_usuario FROM usuarios WHERE CI=? AND id_usuario<>? LIMIT 1', [CI, id]);
    if (dupes.length) return res.status(409).json({ ok:false, msg:'CI ya registrado' });

    // Si viene contraseña, actualiza también
    if (contrasena) {
      await db.query(
        `UPDATE usuarios
           SET nombre=?, CI=?, universidad=?, carrera=?, celular=NULLIF(?,''), estado=?, rol=?, contrasena=?
         WHERE id_usuario=? LIMIT 1`,
        [nombre, CI, universidad, carrera, celular, estado, rol, contrasena, id]
      );
    } else {
      await db.query(
        `UPDATE usuarios
           SET nombre=?, CI=?, universidad=?, carrera=?, celular=NULLIF(?,''), estado=?, rol=?
         WHERE id_usuario=? LIMIT 1`,
        [nombre, CI, universidad, carrera, celular, estado, rol, id]
      );
    }

    const [rows] = await db.query(
      `SELECT id_usuario, nombre, CI, universidad, carrera, celular, estado, rol, contrasena
         FROM usuarios WHERE id_usuario=? LIMIT 1`,
      [id]
    );
    res.json({ ok:true, user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error actualizando usuario' });
  }
});


// ELIMINAR
router.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok:false, msg:'ID inválido' });

    await db.query('DELETE FROM usuarios WHERE id_usuario=? LIMIT 1', [id]);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error eliminando usuario' });
  }
});

module.exports = router;
