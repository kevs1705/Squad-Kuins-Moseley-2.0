// middlewares/auth.js
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

module.exports = { requireAuth };

