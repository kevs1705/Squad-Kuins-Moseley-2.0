const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("../../config/bd");

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.rol !== 1) {
    return res.status(403).send("No autorizado");
  }
  next();
}

const uploadsDir = path.join(process.cwd(), "public", "img", "proyectos");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

const upload = multer({ storage });

router.get("/admin/pagina-web", ensureAdmin, async (req, res) => {
  try {
    const [proyectos] = await db.query(
      "SELECT * FROM proyectos ORDER BY fecha_creacion DESC"
    );
    res.render("pagina_web/admin/index", {
      proyectos,
      msg: req.query.msg || null,
      err: req.query.err || null,
      user: req.session.user
    });
  } catch (err) {
    console.error("Error obteniendo proyectos:", err);
    res.render("pagina_web/admin/index", {
      proyectos: [],
      msg: null,
      err: "No se pudo cargar los proyectos",
      user: req.session.user
    });
  }
});

router.post("/admin/pagina-web", ensureAdmin, upload.single("imagen_file"), async (req, res) => {
  try {
    const {
      titulo,
      categoria,
      descripcion,
      estado,
      ubicacion,
      superficie,
      anio
    } = req.body;

    const imagePath = req.file ? `/img/proyectos/${req.file.filename}` : "";

    const sql = `
      INSERT INTO proyectos (titulo, categoria, descripcion, imagen, estado, ubicacion, superficie, anio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await db.query(sql, [
      titulo,
      categoria,
      descripcion || "",
      imagePath,
      estado || "Entregado",
      ubicacion || "",
      superficie || "",
      anio || null
    ]);
    res.redirect("/admin/pagina-web?msg=Proyecto creado");
  } catch (err) {
    console.error("Error creando proyecto:", err);
    res.redirect("/admin/pagina-web?err=No se pudo crear el proyecto");
  }
});

router.get("/admin/pagina-web/edit/:id", ensureAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM proyectos WHERE id = ?", [
      req.params.id
    ]);
    if (!rows || rows.length === 0) {
      return res.redirect("/admin/pagina-web?err=Proyecto no encontrado");
    }
    res.render("pagina_web/admin/edit", {
      proyecto: rows[0],
      err: req.query.err || null,
      user: req.session.user
    });
  } catch (err) {
    console.error("Error cargando proyecto:", err);
    res.redirect("/admin/pagina-web?err=No se pudo cargar el proyecto");
  }
});

router.post("/admin/pagina-web/edit/:id", ensureAdmin, upload.single("imagen_file"), async (req, res) => {
  try {
    const {
      titulo,
      categoria,
      descripcion,
      estado,
      ubicacion,
      superficie,
      anio
    } = req.body;

    const imagePath = req.file
      ? `/img/proyectos/${req.file.filename}`
      : req.body.imagen_actual || "";

    const sql = `
      UPDATE proyectos
      SET titulo = ?, categoria = ?, descripcion = ?, imagen = ?, estado = ?, ubicacion = ?, superficie = ?, anio = ?
      WHERE id = ?
    `;
    await db.query(sql, [
      titulo,
      categoria,
      descripcion || "",
      imagePath,
      estado || "Entregado",
      ubicacion || "",
      superficie || "",
      anio || null,
      req.params.id
    ]);
    res.redirect("/admin/pagina-web?msg=Proyecto actualizado");
  } catch (err) {
    console.error("Error actualizando proyecto:", err);
    res.redirect(`/admin/pagina-web/edit/${req.params.id}?err=No se pudo actualizar`);
  }
});

router.post("/admin/pagina-web/delete/:id", ensureAdmin, async (req, res) => {
  try {
    await db.query("DELETE FROM proyectos WHERE id = ?", [req.params.id]);
    res.redirect("/admin/pagina-web?msg=Proyecto eliminado");
  } catch (err) {
    console.error("Error eliminando proyecto:", err);
    res.redirect("/admin/pagina-web?err=No se pudo eliminar el proyecto");
  }
});

module.exports = router;

router.get("/admin/mensajes", ensureAdmin, async (req, res) => {
  try {
    const [mensajes] = await db.query(
      "SELECT * FROM mensajes ORDER BY fecha_envio DESC"
    );
    return res.render("pagina_web/admin/mensajes", { mensajes, user: req.session.user });
  } catch (err) {
    console.error("Error obteniendo mensajes:", err);
    return res.render("pagina_web/admin/mensajes", { mensajes: [], user: req.session.user });
  }
});
