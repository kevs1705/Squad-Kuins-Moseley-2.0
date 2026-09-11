const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');

router.get('/notificaciones', requireAuth, async (req, res) => {
  const idUsuario = req.session.user.id_usuario || req.session.user.id || req.session.user.id_user;
  const [rows] = await db.query(
    `SELECT 
      id_notificacion, 
      id_usuario, 
      DATE_FORMAT(fecha_solicitada, '%Y-%m-%d') AS fecha_solicitada, 
      TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio, 
      TIME_FORMAT(hora_fin, '%H:%i') AS hora_fin, 
      horas_cantidad,
      motivo, 
      tarea, 
      comprobante, 
      estado, 
      observacion_admin, 
      creado_en, 
      actualizado_en
     FROM notificaciones
     WHERE id_usuario = ?
     ORDER BY creado_en DESC`,
    [idUsuario]
  );
  res.render('notificaciones', { user: req.session.user, notifs: rows });
});



module.exports = router;
