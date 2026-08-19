const express = require('express');
const router = express.Router();
const db = require('../config/bd.js');

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user.rol !== 0) return res.status(403).send('No autorizado');
  next();
}

module.exports = router;