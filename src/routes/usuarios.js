// routes/usuarios.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd'); // mysql2/promise

// --- IMPORTAMOS LA LIBRERÍA DEL BIOMÉTRICO ---
const Zkteco = require('zkteco-js-with-restart');
const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.0.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;

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

    // 1. GUARDAR EN MYSQL
    const [result] = await db.query(
      `INSERT INTO usuarios (nombre, CI, universidad, carrera, celular, estado, contrasena, rol)
       VALUES (?,?,?,?,?, ?, ?, ?)`,
      [nombre, CI, universidad, carrera, celular || null, estado, contrasena, rol]
    );

    const idGenerado = result.insertId;

    // 2. SINCRONIZAR CON EL BIOMÉTRICO K14 (Envuelto en un try/catch independiente)
    try {
      const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
      await dispositivoZk.createSocket();
      
      // En el K14, el rol 14 es Super Admin, el 0 es Usuario Normal.
      const rolBiometrico = rol === 1 ? 14 : 0; 

      await dispositivoZk.setUser(
        idGenerado,              // uid
        idGenerado.toString(),   // userid
        nombre,                  // nombre
        contrasena,              // clave
        rolBiometrico,           // rol (0 normal, 14 admin)
        0                        // sin tarjeta
      );

      await dispositivoZk.disconnect();
      console.log(`🚀 Usuario [${nombre}] inyectado exitosamente en el K14 con ID: ${idGenerado}`);
    } catch (bioError) {
      // Si el equipo está apagado, falla el K14 pero NO la base de datos.
      console.error('⚠️ Usuario guardado en BD, pero el biométrico no respondió:', bioError.message);
    }

    const [rows] = await db.query(
      `SELECT id_usuario, nombre, CI, universidad, carrera, celular, estado, rol, contrasena
       FROM usuarios WHERE id_usuario=? LIMIT 1`, [idGenerado]
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

    // 1. ELIMINAR DE MYSQL
    await db.query('DELETE FROM usuarios WHERE id_usuario=? LIMIT 1', [id]);
    
    // 2. ELIMINAR DEL BIOMÉTRICO
    try {
      const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
      await dispositivoZk.createSocket();
      await dispositivoZk.deleteUser(id); // Elimina al usuario de la memoria del K14
      await dispositivoZk.disconnect();
      console.log(`🗑️ Usuario con ID ${id} eliminado del biométrico K14`);
    } catch (bioError) {
      console.error('⚠️ Usuario borrado de MySQL, pero no se pudo borrar del biométrico:', bioError.message);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, msg:'Error eliminando usuario' });
  }
});

module.exports = router;