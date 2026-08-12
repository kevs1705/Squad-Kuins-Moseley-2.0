const express = require("express");
const router = express.Router();
const db = require("../../config/bd");

async function fetchProjectsByCategory(category) {
  const sql = `
    SELECT *
    FROM proyectos
    WHERE categoria = ? AND (estado IS NULL OR estado <> 'Desactivado')
    ORDER BY id DESC
  `;
  const [rows] = await db.query(sql, [category]);
  return rows;
}

router.get(["/", "/index"], async (req, res) => {
  try {
    const homeQuery = `
      (SELECT * FROM proyectos WHERE categoria = 'Unifamiliares' AND (estado IS NULL OR estado <> 'Desactivado') ORDER BY id DESC LIMIT 3)
      UNION ALL
      (SELECT * FROM proyectos WHERE categoria = 'Multifamiliares' AND (estado IS NULL OR estado <> 'Desactivado') ORDER BY id DESC LIMIT 3)
      UNION ALL
      (SELECT * FROM proyectos WHERE categoria = 'Especiales' AND (estado IS NULL OR estado <> 'Desactivado') ORDER BY id DESC LIMIT 3)
      ORDER BY id DESC
    `;
    const [proyectos] = await db.query(homeQuery);
    return res.render("pagina_web/index", { proyectos });
  } catch (err) {
    console.error("Home query error:", err);
    return res.render("pagina_web/index", { proyectos: [] });
  }
});

router.get(["/nosotros", "/nosotros.php"], (req, res) => {
  res.render("pagina_web/nosotros");
});

router.get(["/contact", "/contact.php"], (req, res) => {
  res.render("pagina_web/contact", { msg_status: req.query.status || null });
});

router.post(["/contact", "/contact.php"], async (req, res) => {
  try {
    const { nombre, email, asunto, mensaje } = req.body;

    if (!nombre || !email || !mensaje) {
      return res.render("pagina_web/contact", { msg_status: "validation" });
    }

    const insertSql = "INSERT INTO mensajes (nombre, email, asunto, mensaje) VALUES (?, ?, ?, ?)";
    await db.query(insertSql, [nombre, email, asunto || "", mensaje]);

    return res.render("pagina_web/contact", { msg_status: "success" });
  } catch (err) {
    console.error("Contact form error:", err);
    return res.render("pagina_web/contact", { msg_status: "error" });
  }
});

router.get(["/servicios", "/servicios.php"], async (req, res) => {
  try {
    const destacadosSql = "SELECT * FROM proyectos WHERE estado = 'Entregado' ORDER BY id DESC LIMIT 3";
    const [proyectos_destacados] = await db.query(destacadosSql);
    return res.render("pagina_web/servicios", { proyectos_destacados });
  } catch (err) {
    console.error("Servicios query error:", err);
    return res.render("pagina_web/servicios", { proyectos_destacados: [] });
  }
});

router.get(["/proyectos-especiales", "/proyectos-especiales.php"], async (req, res) => {
  try {
    const proyectos = await fetchProjectsByCategory("Especiales");
    return res.render("pagina_web/proyectos-especiales", { proyectos });
  } catch (err) {
    console.error("Especiales query error:", err);
    return res.render("pagina_web/proyectos-especiales", { proyectos: [] });
  }
});

router.get(["/unifamiliares", "/unifamiliares.php"], async (req, res) => {
  try {
    const proyectos = await fetchProjectsByCategory("Unifamiliares");
    return res.render("pagina_web/unifamiliares", { proyectos });
  } catch (err) {
    console.error("Unifamiliares query error:", err);
    return res.render("pagina_web/unifamiliares", { proyectos: [] });
  }
});

router.get(["/multifamiliares", "/multifamiliares.php"], async (req, res) => {
  try {
    const proyectos = await fetchProjectsByCategory("Multifamiliares");
    return res.render("pagina_web/multifamiliares", { proyectos });
  } catch (err) {
    console.error("Multifamiliares query error:", err);
    return res.render("pagina_web/multifamiliares", { proyectos: [] });
  }
});

router.get(["/project-details.php", "/proyectos/:id"], async (req, res) => {
  const id = req.params.id || req.query.id;

  if (!id) {
    return res.status(400).send("ID de proyecto requerido");
  }

  try {
    const [rows] = await db.query("SELECT * FROM proyectos WHERE id = ? LIMIT 1", [id]);

    if (!rows || rows.length === 0 || rows[0].estado === 'Desactivado') {
      return res.status(404).send("Proyecto no encontrado");
    }

    return res.render("pagina_web/project-details", { proyecto: rows[0] });
  } catch (err) {
    console.error("Project detail query error:", err);
    return res.status(500).send("Error al obtener el proyecto");
  }
});

module.exports = router;
