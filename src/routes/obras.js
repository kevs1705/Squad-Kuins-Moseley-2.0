const express = require('express');
const router = express.Router();

const db = require('../config/bd.js');

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.rol !== 1) {
    if (req.xhr || req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ ok: false, msg: 'No autorizado' });
    }
    return res.status(403).render('error', {
      statusCode: 403,
      title: 'No autorizado',
      message: 'No cuentas con permisos de administrador para acceder al módulo de obras.'
    });
  }
  next();
}
// ======================================================
// 1. OBTENER LISTA DE OBRAS
// ======================================================

router.get('/admin/obras', requireAuth, requireAdmin, async (req, res) => {
    try {

        const [lugares] = await db.query(`
            SELECT 
                id_lugar,
                nombre,
                tipo,
                direccion,
                latitud,
                longitud,
                radio_metros,
                estado,
                fecha_inicio,
                fecha_fin,
                descripcion
            FROM lugares
            WHERE tipo = 'OBRA'
            ORDER BY id_lugar DESC
        `);

        res.render('admin/obras', {
            lugares: lugares,
            user: req.user || req.session.user || null //
        });

    } catch (error) {
        console.error('Error al obtener las obras:', error);
        res.status(500).render('error', {
            statusCode: 500,
            title: 'Error en la base de datos',
            message: 'Error al obtener el listado de obras desde la base de datos.'
        });
    }
});


// Helper para extraer coordenadas de enlaces de Google Maps o texto
async function extraerCoordenadasGoogleMaps(input) {
  if (!input || typeof input !== 'string') return null;
  let texto = input.trim();

  // 1. Caso: Coordenadas directas (ej. "-16.504212, -68.129482")
  const regexDirecto = /^(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)$/;
  const matchDirecto = texto.match(regexDirecto);
  if (matchDirecto) {
    const lat = parseFloat(matchDirecto[1]);
    const lng = parseFloat(matchDirecto[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { latitud: lat, longitud: lng };
    }
  }

  // 2. Si es enlace corto (ej. maps.app.goo.gl o goo.gl/maps), seguir redirección
  if (texto.includes('maps.app.goo.gl') || texto.includes('goo.gl/maps')) {
    try {
      const resp = await fetch(texto, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      texto = resp.url || texto;
    } catch (e) {
      console.warn('Error resolviendo URL corta de Google Maps:', e.message);
    }
  }

  // 3. Patrones de Google Maps
  // Patrón A: /@(-16.504212),(-68.129482)
  const matchAt = texto.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (matchAt) {
    return { latitud: parseFloat(matchAt[1]), longitud: parseFloat(matchAt[2]) };
  }

  // Patrón B: !3d(-16.504212)!4d(-68.129482) (Google Maps Place)
  const matchPlace = texto.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (matchPlace) {
    return { latitud: parseFloat(matchPlace[1]), longitud: parseFloat(matchPlace[2]) };
  }

  // Patrón C: ?q=-16.504,-68.129 o ?ll=-16.504,-68.129 o center=-16.504,-68.129
  const matchQuery = texto.match(/[?&](?:q|ll|query|center|daddr)=(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (matchQuery) {
    return { latitud: parseFloat(matchQuery[1]), longitud: parseFloat(matchQuery[2]) };
  }

  // Patrón D: Coordenadas flotantes en cualquier parte del texto
  const matchGenerico = texto.match(/(-?\d{1,2}\.\d{4,})[,\s]+(-?\d{1,3}\.\d{4,})/);
  if (matchGenerico) {
    return { latitud: parseFloat(matchGenerico[1]), longitud: parseFloat(matchGenerico[2]) };
  }

  return null;
}

// Endpoint para procesar enlaces o texto de Google Maps
router.post('/api/obras/parsear-maps', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ ok: false, msg: 'Debes proporcionar un enlace o coordenadas' });
    }

    const coords = await extraerCoordenadasGoogleMaps(url);
    if (!coords) {
      return res.status(422).json({ 
        ok: false, 
        msg: 'No se pudieron extraer coordenadas válidas del enlace o texto proporcionado.' 
      });
    }

    res.json({
      ok: true,
      latitud: coords.latitud,
      longitud: coords.longitud
    });
  } catch (error) {
    console.error('Error parseando Google Maps:', error);
    res.status(500).json({ ok: false, msg: 'Error interno al procesar el enlace' });
  }
});

// ======================================================
// 2. CREAR OBRA
// ======================================================

// Procesar formulario / API
router.post('/api/obras', async (req, res) => {
    try {
        const {
            nombre,
            direccion,
            latitud,
            longitud,
            radio_metros,
            estado,
            fecha_inicio,
            fecha_fin,
            descripcion
        } = req.body;

        if (!nombre) {
            return res.status(400).json({ ok: false, msg: 'El nombre es obligatorio' });
        }

        const [result] = await db.query(`
            INSERT INTO lugares (
                nombre, tipo, direccion, latitud, longitud,
                radio_metros, estado, fecha_inicio, fecha_fin, descripcion
            ) VALUES (?, 'OBRA', ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            nombre,
            direccion || null,
            latitud || null,
            longitud || null,
            radio_metros || null,
            estado ?? 1,
            fecha_inicio || null,
            fecha_fin || null,
            descripcion || null
        ]);

        res.json({
            ok: true,
            msg: 'Obra creada correctamente',
            obra: {
                id_lugar: result.insertId,
                nombre,
                tipo: 'OBRA',
                direccion,
                latitud,
                longitud,
                radio_metros,
                estado: Number(estado ?? 1),
                fecha_inicio,
                fecha_fin,
                descripcion
            }
        });
    } catch (error) {
        console.error('Error al crear obra:', error);
        res.status(500).json({ ok: false, msg: 'Error al registrar la obra' });
    }
});

// ======================================================
// 3. EDITAR OBRA
// ======================================================

// Procesar actualización (Soporta PUT y POST)
const updateObraHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            nombre,
            direccion,
            latitud,
            longitud,
            radio_metros,
            estado,
            fecha_inicio,
            fecha_fin,
            descripcion
        } = req.body;

        if (!nombre) {
            return res.status(400).json({ ok: false, msg: 'El nombre es obligatorio' });
        }

        // Parsear y validar coordenadas numéricas obligatorias
        const lat = parseFloat(latitud);
        const lng = parseFloat(longitud);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ 
                ok: false, 
                msg: 'Las coordenadas de Latitud y Longitud son obligatorias y deben ser números válidos.' 
            });
        }

        const radio = parseInt(radio_metros, 10) || 100;
        const estadoEnum = (req.body.estado == 1 || req.body.estado === 'ACTIVO') 
        ? 'ACTIVO' 
        : 'INACTIVO';
        const [result] = await db.query(`
            UPDATE lugares SET
                nombre = ?,
                direccion = ?,
                latitud = ?,
                longitud = ?,
                radio_metros = ?,
                estado = ?,
                fecha_inicio = ?,
                fecha_fin = ?,
                descripcion = ?
            WHERE id_lugar = ? AND tipo = 'OBRA'
        `, [
            nombre.trim(),
            direccion ? direccion.trim() : null,
            lat,
            lng,
            radio,
            estadoEnum,
            fecha_inicio || null,
            fecha_fin || null,
            descripcion ? descripcion.trim() : null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ ok: false, msg: 'Obra no encontrada' });
        }

        res.json({
            ok: true,
            msg: 'Obra actualizada correctamente',
            obra: {
                id_lugar: Number(id),
                nombre,
                tipo: 'OBRA',
                direccion,
                latitud: lat,
                longitud: lng,
                radio_metros: radio,
                estado: Number(estado),
                fecha_inicio,
                fecha_fin,
                descripcion
            }
        });
    } catch (error) {
        console.error('Error al actualizar obra:', error);
        res.status(500).json({ ok: false, msg: 'Error al actualizar la obra' });
    }
};

router.put('/api/obras/:id', updateObraHandler);
router.post('/api/obras/:id', updateObraHandler); // Fallback si usas POST para actualizar

// ======================================================
// 4. ELIMINAR OBRA
// ======================================================

router.delete('/api/obras/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Verificar si la obra tiene asistencias asociadas
        const [asistencias] = await db.query(
            'SELECT COUNT(*) AS total FROM asistencias WHERE id_lugar = ?',
            [id]
        );

        if (asistencias && asistencias[0] && asistencias[0].total > 0) {
            const total = asistencias[0].total;
            return res.status(400).json({
                ok: false,
                msg: `No se puede eliminar la obra porque tiene ${total} registro(s) de asistencia asociados. Para retirarla de las opciones activas sin alterar el historial, edítala y cambia su estado a "Inactivo".`
            });
        }

        // 2. Si no tiene asistencias asociadas, proceder con el borrado
        const [result] = await db.query(`
            DELETE FROM lugares 
            WHERE id_lugar = ? AND tipo = 'OBRA'
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ ok: false, msg: 'Obra no encontrada' });
        }

        res.json({ ok: true, msg: 'Obra eliminada correctamente' });
    } catch (error) {
        console.error('Error al eliminar obra:', error);
        if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) {
            return res.status(400).json({
                ok: false,
                msg: 'No se puede eliminar esta obra porque tiene registros vinculados en el sistema. Puedes cambiar su estado a "Inactivo" para deshabilitarla.'
            });
        }
        res.status(500).json({ ok: false, msg: 'Error al eliminar la obra' });
    }
});

module.exports = router;