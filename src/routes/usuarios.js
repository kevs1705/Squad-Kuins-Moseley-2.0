// src/routes/usuarios.js
const express = require('express');
const router = express.Router();
const db = require('../config/bd'); // mysql2/promise

// --- INTEGRACIÓN BIOMÉTRICO ZKTECO K14 ---
let Zkteco = null;
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  try {
    Zkteco = require('zkteco-js-with-restart');
  } catch (error) {
    console.warn('⚠️ No se pudo cargar zkteco-js-with-restart en este entorno:', error.message);
  }
}
const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.1.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
   if (req.session.user.rol !== 1) return res.status(403).send('No autorizado');
  next();
}

// =========================================================================
// 1. OBTENER LISTA (READ)
// =========================================================================
router.get('/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    // A. Obtener usuarios con JOIN a la tabla carreras
    const [rows] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.apellido_paterno, u.apellido_materno, u.CI, 
              u.universidad, u.id_carrera, c.nombre AS carrera_nombre, c.siglas AS carrera_siglas,
              u.celular, u.estado, u.rol, u.contrasena
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       ORDER BY u.id_usuario DESC`
    );

    const [carreras] = await db.query(
      `SELECT id_carrera, nombre, siglas FROM carreras ORDER BY id_carrera ASC`
    );

    res.render('usuarios', { 
      title: 'Usuarios — MONSELEY', 
      users: rows, 
      carreras: carreras,
      user: req.session.user 
    });
  } catch (e) {
    console.error('Error al listar usuarios:', e);
    res.status(500).send('Error interno al cargar usuarios');
  }
});

// =========================================================================
// 2. CREAR USUARIO (CREATE)
// =========================================================================
router.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    let { nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular, estado, rol, contrasena } = req.body;

    nombre = String(nombre || '').trim().slice(0, 100);
    apellido_paterno = String(apellido_paterno || '').trim().slice(0, 100);
    apellido_materno = String(apellido_materno || '').trim().slice(0, 100);
    CI = String(CI || '').trim().slice(0, 32);
    universidad = String(universidad || '').trim().slice(0, 120);
    id_carrera = Number(id_carrera) || null;
    celular = String(celular || '').trim().slice(0, 20);
    estado = Number(estado) ? 1 : 0;
    rol = Number(rol) ? 1 : 0;
    contrasena = String(contrasena || '').slice(0, 255);

    if (!nombre || !CI || !universidad || !id_carrera || !contrasena) {
      return res.status(400).json({ ok: false, msg: 'Campos obligatorios: nombre, CI, universidad, carrera, contraseña' });
    }
    if (!/^[0-9.\-]{5,32}$/.test(CI)) {
      return res.status(400).json({ ok: false, msg: 'CI inválido (5–32, dígitos/punto/guion)' });
    }

    const [dupes] = await db.query('SELECT id_usuario FROM usuarios WHERE CI=? LIMIT 1', [CI]);
    if (dupes.length) return res.status(409).json({ ok: false, msg: 'CI ya registrado' });

    // A. Guardar en MySQL
    const [result] = await db.query(
      `INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular, estado, contrasena, rol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular || null, estado, contrasena, rol]
    );

    const idUsuario = result.insertId;

    // B. Enviar al Biométrico K14
    if (estado === 1 && Zkteco) {
      try {
        const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
        await dispositivoZk.createSocket();

        const rolBiometrico = rol === 1 ? 14 : 0;
        // Obtenemos el ID de Departamento (id_carrera directo asignado en la BD)
        const deptoBiometrico = id_carrera ? Number(id_carrera) : 1;

        await dispositivoZk.setUser(
          Number(idUsuario),   // 1. uid
          String(idUsuario),   // 2. userid
          nombre.slice(0, 24), // 3. name
          String(contrasena),  // 4. password
          rolBiometrico,       // 5. role
          0,                   // 6. cardno
          deptoBiometrico      // 7. deptid (Número de departamento creado en el K14)
        );

        await dispositivoZk.disconnect();
        console.log(`🚀 Usuario [${nombre}] registrado en el K14 con ID: ${idUsuario} y Depto ID: ${deptoBiometrico}`);
      } catch (bioError) {
        console.error('⚠️ Usuario guardado en MySQL, pero falló envío al biométrico:', bioError.message);
      }
    } else if (estado === 1) {
      console.log('⚠️ Sincronización con biométrico omitida (librería no disponible en este entorno)');
    }

    // Traer la fila creada con la información de la carrera
    const [rows] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.apellido_paterno, u.apellido_materno, u.CI, 
              u.universidad, u.id_carrera, c.nombre AS carrera_nombre, c.siglas AS carrera_siglas,
              u.celular, u.estado, u.rol, u.contrasena
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       WHERE u.id_usuario=? LIMIT 1`, [idUsuario]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('Error al crear usuario:', e);
    res.status(500).json({ ok: false, msg: 'Error creando usuario' });
  }
});

// =========================================================================
// 3. EDITAR USUARIO (UPDATE)
// =========================================================================
router.post('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, msg: 'ID inválido' });

    const [currentUser] = await db.query('SELECT * FROM usuarios WHERE id_usuario=? LIMIT 1', [id]);
    if (!currentUser.length) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    let { nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular, estado, rol, contrasena } = req.body;

    nombre = String(nombre || '').trim().slice(0, 100);
    apellido_paterno = String(apellido_paterno || '').trim().slice(0, 100);
    apellido_materno = String(apellido_materno || '').trim().slice(0, 100);
    CI = String(CI || '').trim().slice(0, 32);
    universidad = String(universidad || '').trim().slice(0, 120);
    id_carrera = Number(id_carrera) || null;
    celular = String(celular || '').trim().slice(0, 20);
    estado = Number(estado) ? 1 : 0;
    rol = Number(rol) ? 1 : 0;
    contrasena = (contrasena == null) ? '' : String(contrasena).slice(0, 255);

    if (!nombre || !CI || !id_carrera) {
      return res.status(400).json({ ok: false, msg: 'Campos obligatorios: nombre, CI, carrera' });
    }
    if (!/^[0-9.\-]{5,32}$/.test(CI)) {
      return res.status(400).json({ ok: false, msg: 'CI inválido' });
    }

    const [dupes] = await db.query('SELECT id_usuario FROM usuarios WHERE CI=? AND id_usuario<>? LIMIT 1', [CI, id]);
    if (dupes.length) return res.status(409).json({ ok: false, msg: 'CI ya registrado' });

    const contrasenaFinal = contrasena || currentUser[0].contrasena;

    // A. Actualizar en MySQL
    if (contrasena) {
      await db.query(
        `UPDATE usuarios
           SET nombre=?, apellido_paterno=?, apellido_materno=?, CI=?, universidad=?, id_carrera=?, celular=NULLIF(?,''), estado=?, rol=?, contrasena=?
         WHERE id_usuario=? LIMIT 1`,
        [nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular, estado, rol, contrasena, id]
      );
    } else {
      await db.query(
        `UPDATE usuarios
           SET nombre=?, apellido_paterno=?, apellido_materno=?, CI=?, universidad=?, id_carrera=?, celular=NULLIF(?,''), estado=?, rol=?
         WHERE id_usuario=? LIMIT 1`,
        [nombre, apellido_paterno, apellido_materno, CI, universidad, id_carrera, celular, estado, rol, id]
      );
    }

    // B. Sincronizar en el Biométrico K14
    if (Zkteco) {
      try {
        const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
        await dispositivoZk.createSocket();

        if (estado === 1) {
          const rolBiometrico = rol === 1 ? 14 : 0;
          const deptoBiometrico = id_carrera ? Number(id_carrera) : 1;

          await dispositivoZk.setUser(
            id,
            id.toString(),
            nombre.slice(0, 24),
            contrasenaFinal,
            rolBiometrico,
            0,
            deptoBiometrico // <--- Se envía el Depto ID correspondiente
          );
          console.log(`🔄 Usuario [${nombre}] actualizado en el K14 con ID: ${id} y Depto ID: ${deptoBiometrico}`);
        } else {
          await dispositivoZk.deleteUser(id);
          console.log(`🚫 Usuario [${nombre}] desactivado. Removido del K14.`);
        }

        await dispositivoZk.disconnect();
      } catch (bioError) {
        console.error('⚠️ BD actualizada, pero falló sincronización con biométrico:', bioError.message);
      }
    } else {
      console.log('⚠️ Sincronización con biométrico omitida (librería no disponible en este entorno)');
    }

    const [rows] = await db.query(
      `SELECT u.id_usuario, u.nombre, u.apellido_paterno, u.apellido_materno, u.CI, 
              u.universidad, u.id_carrera, c.nombre AS carrera_nombre, c.siglas AS carrera_siglas,
              u.celular, u.estado, u.rol, u.contrasena
       FROM usuarios u
       LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
       WHERE u.id_usuario=? LIMIT 1`,
      [id]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('Error actualizando usuario:', e);
    res.status(500).json({ ok: false, msg: 'Error actualizando usuario' });
  }
});

// =========================================================================
// 4. ELIMINAR USUARIO (DELETE)
// =========================================================================
router.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, msg: 'ID inválido' });

    await db.query('DELETE FROM usuarios WHERE id_usuario=? LIMIT 1', [id]);

    if (Zkteco) {
      try {
        const dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
        await dispositivoZk.createSocket();
        await dispositivoZk.deleteUser(id);
        await dispositivoZk.disconnect();
        console.log(`🗑️ Usuario con ID ${id} eliminado del biométrico K14.`);
      } catch (bioError) {
        console.error('⚠️ Borrado de MySQL, pero no se pudo remover del biométrico:', bioError.message);
      }
    } else {
      console.log('⚠️ Eliminación en biométrico omitida (librería no disponible en este entorno)');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando usuario:', e);
    res.status(500).json({ ok: false, msg: 'Error eliminando usuario' });
  }
});

module.exports = router;