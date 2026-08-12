const express = require('express');
const router = express.Router();
const db = require('../config/bd');
const { requireAuth } = require('../middleware/auth');

router.get('/notificaciones', requireAuth, async (req, res) => {
  const idUsuario = req.session.user.id;
  const [rows] = await db.query(
    `SELECT id_notificacion, id_usuario, fecha_solicitada, hora_inicio, hora_fin, motivo, estado, observacion_admin, creado_en, actualizado_en
     FROM notificaciones
     WHERE id_usuario = ?
     ORDER BY creado_en DESC`,
    [idUsuario]
  );
  res.render('notificaciones', { user: req.session.user, notifs: rows });
});



module.exports = router;
