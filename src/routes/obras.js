const express = require('express');
const router = express.Router();

const db = require('../config/bd.js');

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user.rol !== 1) return res.status(403).send('No autorizado');
  next();
}
// ======================================================
// 1. OBTENER LISTA DE OBRAS
// ======================================================

router.get('/admin/obras', async (req, res) => {
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

        res.status(500).send('Error al obtener las obras');

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
            nombre,
            direccion || null,
            latitud || null,
            longitud || null,
            radio_metros || null,
            estado ?? 1,
            fecha_inicio || null,
            fecha_fin || null,
            descripcion || null,
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
                latitud,
                longitud,
                radio_metros,
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

router.delete('/api/obras/:id', async (req, res) => {
    try {
        const { id } = req.params;

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
        res.status(500).json({ ok: false, msg: 'Error al eliminar la obra' });
    }
});

module.exports = router;