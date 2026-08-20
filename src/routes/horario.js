const express = require('express');
const router = express.Router();

const db = require('../config/bd.js');

// ===============================
// MOSTRAR HORARIO
// ===============================
router.get('/usuario/horario', async (req, res) => {

    try {

        if (!req.session.user) {
            return res.redirect('/login');
        }

        const id_usuario = req.session.user.id_usuario;

        const [horarios] = await db.query(`
            SELECT
                id_horario,
                dia_semana,
                hora_entrada,
                hora_salida,
                estado
            FROM horarios
            WHERE id_usuario = ?
              AND estado = 'ACTIVO'
            ORDER BY dia_semana
        `, [id_usuario]);

        res.render('usuario/horario', {
            user: req.session.user,
            horarios
        });

    } catch (error) {

        console.error('Error cargando horario:', error);

        res.status(500).send('Error al cargar el horario');
    }
});


// ===============================
// GUARDAR HORARIO
// ===============================
router.post('/usuario/horario', async (req, res) => {

    try {

        if (!req.session.user) {
            return res.redirect('/login');
        }

        const id_usuario = req.session.user.id_usuario;

        const {
            dia_semana,
            hora_entrada,
            hora_salida,
            horas
        } = req.body;

        if (
            !dia_semana ||
            !hora_entrada ||
            !hora_salida ||
            !horas
        ) {
            return res.status(400).send('Datos incompletos');
        }

        // Validar duración permitida
        const horasPermitidas = [4, 6, 8];

        if (!horasPermitidas.includes(Number(horas))) {
            return res.status(400).send('Duración no válida');
        }

        // Calcular diferencia
        const inicio = new Date(`1970-01-01T${hora_entrada}:00`);
        const fin = new Date(`1970-01-01T${hora_salida}:00`);

        const diferencia =
            (fin - inicio) / (1000 * 60 * 60);

        if (diferencia !== Number(horas)) {
            return res.status(400).send(
                'La hora de salida no coincide con la duración seleccionada'
            );
        }

        // Insertar o actualizar
        await db.query(`
            INSERT INTO horarios
            (
                id_usuario,
                dia_semana,
                hora_entrada,
                hora_salida,
                estado
            )
            VALUES (?, ?, ?, ?, 'ACTIVO')
            ON DUPLICATE KEY UPDATE
                hora_entrada = VALUES(hora_entrada),
                hora_salida = VALUES(hora_salida),
                estado = 'ACTIVO',
                actualizado_en = CURRENT_TIMESTAMP
        `, [
            id_usuario,
            dia_semana,
            hora_entrada,
            hora_salida
        ]);

        res.redirect('/usuario/horario');

    } catch (error) {

        console.error('Error guardando horario:', error);

        res.status(500).send('Error al guardar horario');
    }
});

module.exports = router;