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

        const id_usuario = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;

        // 1. Obtener los horarios asignados
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

        // 2. Obtener el total de horas acumuladas (en segundos exactos sin truncamiento)
        const [resultadoHoras] = await db.query(`
            SELECT COALESCE(
              SUM(
                TIMESTAMPDIFF(
                  SECOND, 
                  TIMESTAMP(fecha, hora_entrada), 
                  TIMESTAMP(fecha, hora_salida)
                )
              ), 0
            ) AS total_segundos
            FROM asistencias
            WHERE id_usuario = ?
              AND estado != 'ANULADO'
              AND hora_entrada IS NOT NULL
              AND hora_salida IS NOT NULL
        `, [id_usuario]);

        const totalSegundos = resultadoHoras[0]?.total_segundos || 0;
        const totalHorasSistema = Math.round(totalSegundos / 3600);

        res.render('usuario/horario', {
            user: req.session.user,
            horarios,
            totalHorasSistema
        });

    } catch (error) {
        console.error('Error cargando horario:', error);
        res.status(500).send('Error al cargar el horario');
    }
});

// GUARDAR HORARIO (DÍAS MÚLTIPLES)
// ===============================
router.post('/usuario/horario', async (req, res) => {
    try {
        if (!req.session.user) {
            return res.redirect('/login');
        }

        console.log('--- OBJETO SESIÓN USUARIO ---', req.session.user);

        // Extraer el ID asegurando compatibilidad con distintas nomenclaturas (id_usuario, id, id_user)
        const id_usuario = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;

        if (!id_usuario) {
            return res.status(401).send('Error de autenticación: No se encontró la clave de identificación del usuario en la sesión.');
        }

        let {
            dias_semana,
            hora_entrada,
            hora_salida
        } = req.body;

        if (!dias_semana || !hora_entrada || !hora_salida) {
            return res.status(400).send('Datos incompletos.');
        }

        if (!Array.isArray(dias_semana)) {
            dias_semana = [dias_semana];
        }

        for (const dia of dias_semana) {
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
                dia,
                hora_entrada,
                hora_salida
            ]);
        }

        res.redirect('/usuario/horario');

    } catch (error) {
        console.error('Error guardando horario:', error);
        res.status(500).send('Error al guardar el horario');
    }
});

// ===============================
// ELIMINAR DÍA DE HORARIO
// ===============================
router.post('/usuario/horario/eliminar/:id', async (req, res) => {
    try {
        if (!req.session.user) {
            return res.redirect('/login');
        }

        const id_usuario = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;
        const id_horario = req.params.id;

        if (!id_usuario || !id_horario) {
            return res.status(400).send('Parámetros inválidos.');
        }

        await db.query(`
            DELETE FROM horarios
            WHERE id_horario = ? AND id_usuario = ?
        `, [id_horario, id_usuario]);

        res.redirect('/usuario/horario');
    } catch (error) {
        console.error('Error eliminando horario:', error);
        res.status(500).send('Error al eliminar el horario');
    }
});

module.exports = router;