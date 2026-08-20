// routes/dashboard.js (o donde tengas este router)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// Dashboard: pasantes ven panel de selección, admins van a /cuenta
router.get('/dashboard', requireAuth, (req, res) => {
  if (req.session.user.rol === 1) {
    return res.redirect('/cuenta');
  }
  // Pasante → mostrar opciones de asistencia
  res.render('dashboard', { user: req.session.user });
});

// Logout (simple)
router.get('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
