// routes/graficos.js
const express = require("express");
const router = express.Router();
const db = require("../config/bd"); // mysql2/promise
const ExcelJS = require("exceljs");
const { requireAuth } = require("../middleware/auth");

// Helper para verificar rol admin (rol = 1)
function requireAdmin(req, res, next) {
  if (req.session?.user && req.session.user.rol === 1) {
    return next();
  }
  return res.status(403).send("Acceso restringido a administradores");
}

/**
 * GET /graficos
 * Vista principal de estadísticas BI (Dark Neón)
 */
router.get("/graficos", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [carreras] = await db.query(
      `SELECT id_carrera, nombre, siglas FROM carreras WHERE estado = 1 ORDER BY nombre ASC`
    );

    const [pasantes] = await db.query(
      `SELECT u.id_usuario, 
              CONCAT(u.nombre, ' ', COALESCE(u.apellido_paterno,''), ' ', COALESCE(u.apellido_materno,'')) AS nombre_completo,
              u.nombre, u.apellido_paterno, u.CI, u.universidad,
              COALESCE(u.id_carrera, u.carrera) AS id_carrera,
              c.nombre AS carrera_nombre,
              c.siglas AS carrera_siglas,
              DATE_FORMAT(u.fecha_inicio_pasantia, '%Y-%m-%d') AS fecha_inicio_pasantia
       FROM usuarios u
       LEFT JOIN carreras c ON (u.id_carrera = c.id_carrera OR u.carrera = c.id_carrera)
       WHERE u.rol = 0 AND u.estado = 1
       ORDER BY u.nombre ASC`
    );

    res.render("graficos", {
      user: req.session.user,
      carreras,
      pasantes,
      pageTitle: "Estadísticas y Analítica BI",
      pageSubtitle: "Tablero Ejecutivo de Rendimiento y Horas de Pasantías — MONSELEY"
    });
  } catch (e) {
    console.error("GET /graficos error:", e);
    res.render("graficos", {
      user: req.session?.user || null,
      carreras: [],
      pasantes: [],
      pageTitle: "Estadísticas y Analítica BI",
      pageSubtitle: "Error al cargar datos"
    });
  }
});

/**
 * GET /api/graficos/analytics
 * Endpoint unificado para filtros por Estudiante, por Carrera y en General
 */
router.get("/api/graficos/analytics", requireAuth, requireAdmin, async (req, res) => {
  try {
    const modo = req.query.modo || "general"; // 'general' | 'carrera' | 'estudiante'
    const carreraId = req.query.carreraId ? Number(req.query.carreraId) : null;
    const estudianteId = req.query.estudianteId ? Number(req.query.estudianteId) : null;
    const periodo = req.query.periodo || "all"; // 'all' | 'mes' | 'trimestre' | 'anio' | 'custom'
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const orden = (req.query.orden || "desc").toLowerCase(); // 'desc' | 'asc'
    const filtroRendimiento = req.query.filtroRendimiento || "todos"; // 'todos' | 'menos_100' | 'por_acabar' | 'completado'

    // 1. Filtrar Pasantes en Scope (Solo usuarios activos estado = 1)
    let userWhere = "u.rol = 0 AND u.estado = 1";
    const userParams = [];

    if (modo === "estudiante" && estudianteId) {
      userWhere += " AND u.id_usuario = ?";
      userParams.push(estudianteId);
    } else if (carreraId) {
      userWhere += " AND (u.id_carrera = ? OR u.carrera = ?)";
      userParams.push(carreraId, carreraId);
    }

    const [pasantes] = await db.query(
      `SELECT u.id_usuario, 
              CONCAT(u.nombre, ' ', COALESCE(u.apellido_paterno,''), ' ', COALESCE(u.apellido_materno,'')) AS nombre_completo,
              u.CI, u.universidad, u.celular, COALESCE(u.id_carrera, u.carrera) AS id_carrera,
              COALESCE(c.nombre, 'Sin Carrera') AS carrera_nombre,
              COALESCE(c.siglas, 'GEN') AS carrera_siglas,
              DATE_FORMAT(u.fecha_inicio_pasantia, '%Y-%m-%d') AS fecha_inicio_pasantia
       FROM usuarios u
       LEFT JOIN carreras c ON (u.id_carrera = c.id_carrera OR u.carrera = c.id_carrera)
       WHERE ${userWhere}
       ORDER BY u.nombre ASC`,
      userParams
    );

    const pasanteIds = pasantes.map((p) => p.id_usuario);
    if (pasanteIds.length === 0) {
      return res.json({
        ok: true,
        kpis: {
          totalPasantes: 0,
          totalHoras: 0,
          promedioHoras: 0,
          horasPresencial: 0,
          horasTeletrabajo: 0,
          horasExtra: 0,
          tasaCumplimiento: 0,
          carreraLider: "N/A",
          asistenciasCount: 0
        },
        seriesTemporal: { labels: [], horas: [], acumulado: [], teletrabajo: [], horas_extra: [] },
        porCarrera: { labels: [], horas: [], estudiantes: [] },
        rankingEstudiantes: [],
        diasSemana: [],
        estudiantePerfil: null
      });
    }

    // 2. Filtro de Fechas para Asistencias, Teletrabajo y Horas Extras
    let fechaWhereAsistencias = "";
    const fechaParamsAsistencias = [];

    if (periodo === "mes") {
      fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)";
    } else if (periodo === "trimestre") {
      fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)";
    } else if (periodo === "anio") {
      fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)";
    } else if (periodo === "custom" && desde && hasta) {
      fechaWhereAsistencias = " AND a.fecha BETWEEN ? AND ?";
      fechaParamsAsistencias.push(desde, hasta);
    }

    // Consultar Asistencias válidas (presencial y teletrabajo identificados por asistencias_geo)
    const [asistencias] = await db.query(
      `SELECT a.id_asistencia, a.id_usuario, a.fecha, a.hora_entrada, a.hora_salida, a.estado, a.id_lugar,
              COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
              TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)) AS duracion_segundos
       FROM asistencias a
       LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
       WHERE a.id_usuario IN (?) AND a.estado NOT IN ('ANULADO', 'RECHAZADO') 
         AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL
         ${fechaWhereAsistencias}
       ORDER BY a.fecha ASC`,
      [pasanteIds, ...fechaParamsAsistencias]
    );

    // Consultar Horas Extras Aprobadas (notificaciones estado = 2, multiplicadas x2 según normativa del sistema)
    let fechaWhereExtra = "";
    const fechaParamsExtra = [];
    if (periodo === "mes") {
      fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)";
    } else if (periodo === "trimestre") {
      fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)";
    } else if (periodo === "anio") {
      fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)";
    } else if (periodo === "custom" && desde && hasta) {
      fechaWhereExtra = " AND n.fecha_solicitada BETWEEN ? AND ?";
      fechaParamsExtra.push(desde, hasta);
    }

    const [horasExtras] = await db.query(
      `SELECT n.id_notificacion, n.id_usuario, n.fecha_solicitada,
              TIMESTAMPDIFF(SECOND, TIMESTAMP(n.fecha_solicitada, n.hora_inicio), TIMESTAMP(n.fecha_solicitada, n.hora_fin)) * 2 AS duracion_segundos
       FROM notificaciones n
       WHERE n.id_usuario IN (?) AND n.estado = 2
         AND n.hora_inicio IS NOT NULL AND n.hora_fin IS NOT NULL
         ${fechaWhereExtra}
       ORDER BY n.fecha_solicitada ASC`,
      [pasanteIds, ...fechaParamsExtra]
    );

    // 3. Cálculos de Totales y Agrupaciones en Segundos Exactos
    let totalSegundosPresencial = 0;
    let totalSegundosTeletrabajo = 0;
    let totalSegundosExtras = 0;

    const userHorasMap = {};
    const weekMap = {};
    const diasNombres = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
    const diaStats = diasNombres.map((name, idx) => ({
      dia_idx: idx,
      dia_nombre: name,
      total_segundos: 0,
      total_asistencias: 0
    }));

    pasanteIds.forEach((id) => {
      userHorasMap[id] = {
        segundos_presencial: 0,
        segundos_teletrabajo: 0,
        segundos_extra: 0,
        total_segundos: 0
      };
    });

    asistencias.forEach((a) => {
      const sec = Number(a.duracion_segundos || 0);
      const isTele = (a.modalidad || "").toUpperCase() === "TELETRABAJO";

      if (isTele) {
        totalSegundosTeletrabajo += sec;
        if (userHorasMap[a.id_usuario]) {
          userHorasMap[a.id_usuario].segundos_teletrabajo += sec;
          userHorasMap[a.id_usuario].total_segundos += sec;
        }
      } else {
        totalSegundosPresencial += sec;
        if (userHorasMap[a.id_usuario]) {
          userHorasMap[a.id_usuario].segundos_presencial += sec;
          userHorasMap[a.id_usuario].total_segundos += sec;
        }
      }

      // Agrupación semanal
      if (a.fecha) {
        let d = null;
        if (a.fecha instanceof Date) {
          d = a.fecha;
        } else if (typeof a.fecha === "string") {
          d = new Date(a.fecha.includes("T") ? a.fecha : a.fecha + "T12:00:00");
        }

        if (d && !isNaN(d.getTime())) {
          const day = d.getDay();
          const diff = d.getDate() - day + (day === 0 ? -6 : 1);
          const mon = new Date(d);
          mon.setDate(diff);
          const monStr = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;

          if (!weekMap[monStr]) {
            weekMap[monStr] = { semana_inicio: monStr, semana_label: `Sem ${monStr.slice(5)}`, horas: 0, teletrabajo: 0, horas_extra: 0 };
          }
          if (isTele) {
            weekMap[monStr].teletrabajo += sec / 3600;
          } else {
            weekMap[monStr].horas += sec / 3600;
          }

          // Día de la semana (0 = Lunes, 6 = Domingo)
          const diaIdx = day === 0 ? 6 : day - 1;
          if (diaStats[diaIdx]) {
            diaStats[diaIdx].total_segundos += sec;
            diaStats[diaIdx].total_asistencias += 1;
          }
        }
      }
    });

    horasExtras.forEach((h) => {
      const sec = Number(h.duracion_segundos || 0);
      totalSegundosExtras += sec;

      if (userHorasMap[h.id_usuario]) {
        userHorasMap[h.id_usuario].segundos_extra += sec;
        userHorasMap[h.id_usuario].total_segundos += sec;
      }

      if (h.fecha_solicitada) {
        let d = null;
        if (h.fecha_solicitada instanceof Date) {
          d = h.fecha_solicitada;
        } else if (typeof h.fecha_solicitada === "string") {
          d = new Date(h.fecha_solicitada.includes("T") ? h.fecha_solicitada : h.fecha_solicitada + "T12:00:00");
        }

        if (d && !isNaN(d.getTime())) {
          const day = d.getDay();
          const diff = d.getDate() - day + (day === 0 ? -6 : 1);
          const mon = new Date(d);
          mon.setDate(diff);
          const monStr = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;

          if (!weekMap[monStr]) {
            weekMap[monStr] = { semana_inicio: monStr, semana_label: `Sem ${monStr.slice(5)}`, horas: 0, teletrabajo: 0, horas_extra: 0 };
          }
          weekMap[monStr].horas_extra += sec / 3600;
        }
      }
    });

    const totalSegundosGlobal = totalSegundosPresencial + totalSegundosTeletrabajo + totalSegundosExtras;
    const totalHorasGlobal = Number((totalSegundosGlobal / 3600).toFixed(1));
    const horasPresencialGlobal = Number((totalSegundosPresencial / 3600).toFixed(1));
    const horasTeletrabajoGlobal = Number((totalSegundosTeletrabajo / 3600).toFixed(1));
    const horasExtrasGlobal = Number((totalSegundosExtras / 3600).toFixed(1));
    const totalPasantesCount = pasantes.length;
    const promedioHorasGlobal = totalPasantesCount > 0 ? Number((totalHorasGlobal / totalPasantesCount).toFixed(1)) : 0;

    // Meta: 280 hrs por pasante
    const metaScope = totalPasantesCount * 280;
    const tasaCumplimientoGlobal = metaScope > 0 ? Math.min(100, Math.round((totalHorasGlobal / metaScope) * 100)) : 0;

    // Series Temporales Semanales
    const sortedWeeks = Object.values(weekMap).sort((a, b) => a.semana_inicio.localeCompare(b.semana_inicio));
    let acumulador = 0;
    const seriesTemporal = {
      labels: sortedWeeks.map((w) => w.semana_label),
      horas: sortedWeeks.map((w) => Number(w.horas.toFixed(1))),
      teletrabajo: sortedWeeks.map((w) => Number(w.teletrabajo.toFixed(1))),
      horas_extra: sortedWeeks.map((w) => Number((w.horas_extra || 0).toFixed(1))),
      acumulado: sortedWeeks.map((w) => {
        acumulador += w.horas + w.teletrabajo + (w.horas_extra || 0);
        return Number(acumulador.toFixed(1));
      })
    };

    // Distribución por Carrera
    const carreraMap = {};
    pasantes.forEach((p) => {
      const cNom = p.carrera_nombre || "Sin Carrera";
      if (!carreraMap[cNom]) {
        carreraMap[cNom] = { carrera: cNom, horas: 0, estudiantes: 0 };
      }
      carreraMap[cNom].estudiantes += 1;
      const uH = (userHorasMap[p.id_usuario]?.total_segundos || 0) / 3600;
      carreraMap[cNom].horas += uH;
    });

    const porCarreraList = Object.values(carreraMap).sort((a, b) => b.horas - a.horas);
    const carreraLider = porCarreraList.length > 0 && porCarreraList[0].horas > 0 ? porCarreraList[0].carrera : "En curso";

    const porCarrera = {
      labels: porCarreraList.map((c) => c.carrera),
      horas: porCarreraList.map((c) => Number(c.horas.toFixed(1))),
      estudiantes: porCarreraList.map((c) => c.estudiantes)
    };

    // Ranking de Estudiantes (con soporte para orden 'asc' o 'desc' hacia meta de 280 hrs)
    let rankingEstudiantes = pasantes
      .map((p) => {
        const u = userHorasMap[p.id_usuario] || { segundos_presencial: 0, segundos_teletrabajo: 0, segundos_extra: 0, total_segundos: 0 };
        const hVal = Number((u.total_segundos / 3600).toFixed(1));
        const presVal = Number((u.segundos_presencial / 3600).toFixed(1));
        const teleVal = Number((u.segundos_teletrabajo / 3600).toFixed(1));
        const extraVal = Number((u.segundos_extra / 3600).toFixed(1));
        const pct = Math.min(100, Math.round((hVal / 280) * 100));
        return {
          id_usuario: p.id_usuario,
          nombre: p.nombre_completo,
          ci: p.CI || "S/N",
          celular: p.celular || "Sin celular",
          carrera: p.carrera_nombre,
          carrera_siglas: p.carrera_siglas,
          horas: hVal,
          presencial: presVal,
          teletrabajo: teleVal,
          horas_extra: extraVal,
          porcentaje: pct
        };
      })
      .sort((a, b) => (orden === "asc" ? a.horas - b.horas : b.horas - a.horas));

    // Filtro dinámico de rendimiento si se especifica
    if (filtroRendimiento === "menos_100") {
      rankingEstudiantes = rankingEstudiantes.filter((p) => p.horas < 100);
    } else if (filtroRendimiento === "por_acabar") {
      rankingEstudiantes = rankingEstudiantes.filter((p) => p.horas >= 200 && p.horas < 280);
    } else if (filtroRendimiento === "completado") {
      rankingEstudiantes = rankingEstudiantes.filter((p) => p.horas >= 280);
    }

    // Días de la semana (Lunes a Sábado)
    const diasSemana = diaStats.slice(0, 6).map((d) => ({
      dia: d.dia_nombre,
      horas: Number((d.total_segundos / 3600).toFixed(1)),
      promedio: d.total_asistencias > 0 ? Number((d.total_segundos / 3600 / d.total_asistencias).toFixed(1)) : 0
    }));

    // Ficha de Estudiante (si modo === 'estudiante')
    let estudiantePerfil = null;
    if (modo === "estudiante" && pasantes.length === 1) {
      const p = pasantes[0];
      const u = userHorasMap[p.id_usuario] || { segundos_presencial: 0, segundos_teletrabajo: 0, segundos_extra: 0, total_segundos: 0 };
      const hVal = Number((u.total_segundos / 3600).toFixed(1));
      const presVal = Number((u.segundos_presencial / 3600).toFixed(1));
      const teleVal = Number((u.segundos_teletrabajo / 3600).toFixed(1));
      const extraVal = Number((u.segundos_extra / 3600).toFixed(1));
      const pct = Math.min(100, Math.round((hVal / 280) * 100));

      const [recientes] = await db.query(
        `SELECT DATE_FORMAT(a.fecha, '%d/%m/%Y') AS fecha_formateada,
                DATE_FORMAT(a.hora_entrada, '%H:%i') AS hora_entrada,
                DATE_FORMAT(a.hora_salida, '%H:%i') AS hora_salida,
                a.estado,
                COALESCE(l.nombre, 'Oficina Central') AS lugar_nombre,
                ROUND(TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)) / 3600, 1) AS duracion
         FROM asistencias a
         LEFT JOIN lugares l ON l.id_lugar = a.id_lugar
         WHERE a.id_usuario = ? AND a.estado NOT IN ('ANULADO', 'RECHAZADO')
           AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL
         ORDER BY a.fecha DESC
         LIMIT 6`,
        [p.id_usuario]
      );

      estudiantePerfil = {
        id_usuario: p.id_usuario,
        nombre: p.nombre_completo,
        ci: p.CI,
        universidad: p.universidad || "N/A",
        carrera: p.carrera_nombre,
        carrera_siglas: p.carrera_siglas,
        fecha_inicio: p.fecha_inicio_pasantia || "No especificada",
        total_horas: hVal,
        horas_presencial: presVal,
        horas_teletrabajo: teleVal,
        horas_extra: extraVal,
        horas_restantes: Math.max(0, Number((280 - hVal).toFixed(1))),
        porcentaje_meta: pct,
        asistencias_recientes: recientes
      };
    }

    res.json({
      ok: true,
      orden,
      kpis: {
        totalPasantes: totalPasantesCount,
        totalHoras: totalHorasGlobal,
        promedioHoras: promedioHorasGlobal,
        horasPresencial: horasPresencialGlobal,
        horasTeletrabajo: horasTeletrabajoGlobal,
        horasExtra: horasExtrasGlobal,
        tasaCumplimiento: tasaCumplimientoGlobal,
        carreraLider,
        asistenciasCount: asistencias.length
      },
      seriesTemporal,
      porCarrera,
      rankingEstudiantes,
      diasSemana,
      estudiantePerfil
    });
  } catch (err) {
    console.error("Error en /api/graficos/analytics:", err);
    res.status(500).json({ ok: false, msg: "Error al procesar analítica de gráficos" });
  }
});

/**
 * GET /api/graficos/export-pasantes-excel
 * Exportación a Excel del Detalle Rápido de Pasantes con Ranking, Contacto, Horas y Alerta < 100 hrs
 */
router.get("/api/graficos/export-pasantes-excel", requireAuth, requireAdmin, async (req, res) => {
  try {
    const modo = req.query.modo || "general";
    const carreraId = req.query.carreraId ? Number(req.query.carreraId) : null;
    const estudianteId = req.query.estudianteId ? Number(req.query.estudianteId) : null;
    const periodo = req.query.periodo || "all";
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const orden = (req.query.orden || "desc").toLowerCase();
    const filtroRendimiento = req.query.filtroRendimiento || "todos"; // 'todos' | 'menos_100' | 'por_acabar' | 'completado'

    // 1. Filtrar Pasantes en Scope (Solo usuarios activos estado = 1)
    let userWhere = "u.rol = 0 AND u.estado = 1";
    const userParams = [];

    if (modo === "estudiante" && estudianteId) {
      userWhere += " AND u.id_usuario = ?";
      userParams.push(estudianteId);
    } else if (carreraId) {
      userWhere += " AND (u.id_carrera = ? OR u.carrera = ?)";
      userParams.push(carreraId, carreraId);
    }

    const [pasantes] = await db.query(
      `SELECT u.id_usuario, 
              CONCAT(u.nombre, ' ', COALESCE(u.apellido_paterno,''), ' ', COALESCE(u.apellido_materno,'')) AS nombre_completo,
              u.CI, u.universidad, u.celular, COALESCE(u.id_carrera, u.carrera) AS id_carrera,
              COALESCE(c.nombre, 'Sin Carrera') AS carrera_nombre,
              COALESCE(c.siglas, 'GEN') AS carrera_siglas,
              DATE_FORMAT(u.fecha_inicio_pasantia, '%d/%m/%Y') AS fecha_inicio_pasantia
       FROM usuarios u
       LEFT JOIN carreras c ON (u.id_carrera = c.id_carrera OR u.carrera = c.id_carrera)
       WHERE ${userWhere}
       ORDER BY u.nombre ASC`,
      userParams
    );

    const pasanteIds = pasantes.map((p) => p.id_usuario);
    const userHorasMap = {};
    pasantes.forEach((p) => {
      userHorasMap[p.id_usuario] = {
        segundos_presencial: 0,
        segundos_teletrabajo: 0,
        segundos_extra: 0,
        total_segundos: 0
      };
    });

    if (pasanteIds.length > 0) {
      // 2. Filtro de Fechas
      let fechaWhereAsistencias = "";
      const fechaParamsAsistencias = [];

      if (periodo === "mes") {
        fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)";
      } else if (periodo === "trimestre") {
        fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)";
      } else if (periodo === "anio") {
        fechaWhereAsistencias = " AND a.fecha >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)";
      } else if (periodo === "custom" && desde && hasta) {
        fechaWhereAsistencias = " AND a.fecha BETWEEN ? AND ?";
        fechaParamsAsistencias.push(desde, hasta);
      }

      const [asistencias] = await db.query(
        `SELECT a.id_asistencia, a.id_usuario, a.fecha, a.hora_entrada, a.hora_salida, a.estado, a.id_lugar,
                COALESCE(ag.modalidad, 'PRESENCIAL') AS modalidad,
                TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)) AS duracion_segundos
         FROM asistencias a
         LEFT JOIN asistencias_geo ag ON ag.id_asistencia = a.id_asistencia
         WHERE a.id_usuario IN (?) AND a.estado NOT IN ('ANULADO', 'RECHAZADO') 
           AND a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL
           ${fechaWhereAsistencias}`,
        [pasanteIds, ...fechaParamsAsistencias]
      );

      let fechaWhereExtra = "";
      const fechaParamsExtra = [];
      if (periodo === "mes") {
        fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)";
      } else if (periodo === "trimestre") {
        fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)";
      } else if (periodo === "anio") {
        fechaWhereExtra = " AND n.fecha_solicitada >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)";
      } else if (periodo === "custom" && desde && hasta) {
        fechaWhereExtra = " AND n.fecha_solicitada BETWEEN ? AND ?";
        fechaParamsExtra.push(desde, hasta);
      }

      const [horasExtras] = await db.query(
        `SELECT n.id_notificacion, n.id_usuario, n.fecha_solicitada,
                TIMESTAMPDIFF(SECOND, TIMESTAMP(n.fecha_solicitada, n.hora_inicio), TIMESTAMP(n.fecha_solicitada, n.hora_fin)) * 2 AS duracion_segundos
         FROM notificaciones n
         WHERE n.id_usuario IN (?) AND n.estado = 2
           AND n.hora_inicio IS NOT NULL AND n.hora_fin IS NOT NULL
           ${fechaWhereExtra}`,
        [pasanteIds, ...fechaParamsExtra]
      );

      asistencias.forEach((a) => {
        const sec = Number(a.duracion_segundos || 0);
        const isTele = (a.modalidad || "").toUpperCase() === "TELETRABAJO";
        if (userHorasMap[a.id_usuario]) {
          if (isTele) {
            userHorasMap[a.id_usuario].segundos_teletrabajo += sec;
          } else {
            userHorasMap[a.id_usuario].segundos_presencial += sec;
          }
          userHorasMap[a.id_usuario].total_segundos += sec;
        }
      });

      horasExtras.forEach((h) => {
        const sec = Number(h.duracion_segundos || 0);
        if (userHorasMap[h.id_usuario]) {
          userHorasMap[h.id_usuario].segundos_extra += sec;
          userHorasMap[h.id_usuario].total_segundos += sec;
        }
      });
    }

    // Preparar lista procesada con ranking
    let listaPasantes = pasantes
      .map((p) => {
        const u = userHorasMap[p.id_usuario] || { segundos_presencial: 0, segundos_teletrabajo: 0, segundos_extra: 0, total_segundos: 0 };
        const pres = Number((u.segundos_presencial / 3600).toFixed(1));
        const tele = Number((u.segundos_teletrabajo / 3600).toFixed(1));
        const ext = Number((u.segundos_extra / 3600).toFixed(1));
        const total = Number((u.total_segundos / 3600).toFixed(1));
        const meta = 280;
        const restantes = Math.max(0, Number((meta - total).toFixed(1)));
        const porcentaje = Math.min(100, Math.round((total / meta) * 100));

        let estadoRendimiento = "En Progreso";
        let bajoRendimiento = false;
        let porAcabar = false;

        if (total < 100) {
          estadoRendimiento = "Menor a 100 hrs (Contactar)";
          bajoRendimiento = true;
        } else if (total >= meta) {
          estadoRendimiento = "Meta Cumplida";
        } else if (total >= 200) {
          estadoRendimiento = "Por Acabar (≥ 200 hrs)";
          porAcabar = true;
        }

        return {
          id_usuario: p.id_usuario,
          nombre: p.nombre_completo.trim(),
          ci: p.CI || "S/N",
          celular: p.celular || "Sin celular",
          carrera: p.carrera_nombre,
          carrera_siglas: p.carrera_siglas,
          universidad: p.universidad || "N/A",
          presencial: pres,
          teletrabajo: tele,
          horas_extra: ext,
          total_horas: total,
          meta: meta,
          horas_restantes: restantes,
          porcentaje: porcentaje,
          estado: estadoRendimiento,
          bajoRendimiento: bajoRendimiento,
          porAcabar: porAcabar
        };
      })
      .sort((a, b) => (orden === "asc" ? a.total_horas - b.total_horas : b.total_horas - a.total_horas));

    // Aplicar filtro dinámico de rendimiento si se especifica (sin emojis)
    let subtituloFiltro = "Todos los Pasantes";
    if (filtroRendimiento === "menos_100") {
      listaPasantes = listaPasantes.filter((p) => p.total_horas < 100);
      subtituloFiltro = "Pasantes con Menos de 100 hrs (Para Contactar)";
    } else if (filtroRendimiento === "por_acabar") {
      listaPasantes = listaPasantes.filter((p) => p.total_horas >= 200 && p.total_horas < 280);
      subtituloFiltro = "Pasantes por Culminar Pasantía (≥ 200 hrs)";
    } else if (filtroRendimiento === "completado") {
      listaPasantes = listaPasantes.filter((p) => p.total_horas >= 280);
      subtituloFiltro = "Pasantes con Meta Cumplida (≥ 280 hrs)";
    }

    // Crear libro Excel con ExcelJS
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "BYGGER SRL - MONSELEY";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Detalle Pasantes", {
      views: [{ showGridLines: true }]
    });

    // 1. Título y Encabezado de la Empresa
    sheet.mergeCells("A1:N1");
    const titleCell = sheet.getCell("A1");
    titleCell.value = "BYGGER SRL · MONSELEY — SISTEMA DE GESTIÓN Y AUDITORÍA DE PASANTES";
    titleCell.font = { name: "Arial", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
    titleCell.alignment = { vertical: "middle", horizontal: "center" };
    titleCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F5FA6" } // Azul Monseley
    };
    sheet.getRow(1).height = 36;

    sheet.mergeCells("A2:N2");
    const subCell = sheet.getCell("A2");
    const fechaGen = new Date().toLocaleDateString("es-BO", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const countBajo = listaPasantes.filter(p => p.bajoRendimiento).length;
    subCell.value = `Filtro: ${subtituloFiltro} | Meta Institucional: 280 hrs | Generado: ${fechaGen} | Total Pasantes en Reporte: ${listaPasantes.length} | Alerta (< 100 hrs): ${countBajo}`;
    subCell.font = { name: "Arial", size: 10, italic: true, color: { argb: "FF334155" } };
    subCell.alignment = { vertical: "middle", horizontal: "center" };
    subCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF1F5F9" }
    };
    sheet.getRow(2).height = 24;

    sheet.addRow([]); // Espacio

    // 2. Encabezados de Columnas (Celular directamente después de C.I.)
    const headers = [
      "Ranking",
      "Pasante",
      "C.I.",
      "Celular / Contacto",
      "Carrera",
      "Universidad",
      "Presencial (hrs)",
      "Teletrabajo (hrs)",
      "Horas Extras x2 (hrs)",
      "Total Acumulado (hrs)",
      "Meta (hrs)",
      "Horas Restantes (hrs)",
      "% Avance",
      "Estado de Rendimiento"
    ];

    const headerRow = sheet.addRow(headers);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1E293B" } // Slate oscuro corporativo
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FFCBD5E1" } },
        bottom: { style: "medium", color: { argb: "FF0F5FA6" } },
        left: { style: "thin", color: { argb: "FFCBD5E1" } },
        right: { style: "thin", color: { argb: "FFCBD5E1" } }
      };
    });

    // 3. Filas de Datos
    listaPasantes.forEach((p, index) => {
      const row = sheet.addRow([
        index + 1,
        p.nombre,
        p.ci,
        p.celular,
        p.carrera,
        p.universidad,
        p.presencial,
        p.teletrabajo,
        p.horas_extra,
        p.total_horas,
        p.meta,
        p.horas_restantes,
        `${p.porcentaje}%`,
        p.estado
      ]);

      row.height = 22;

      // Estilos y alertas por celda
      row.eachCell((cell, colNumber) => {
        cell.font = { name: "Arial", size: 9.5 };
        cell.border = {
          top: { style: "thin", color: { argb: "FFE2E8F0" } },
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
          left: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } }
        };

        // Alineaciones
        if ([1, 3, 4, 7, 8, 9, 10, 11, 12, 13].includes(colNumber)) {
          cell.alignment = { vertical: "middle", horizontal: "center" };
        } else {
          cell.alignment = { vertical: "middle", horizontal: "left" };
        }

        // Resaltado de pasantes con < 100 hrs (alerta especial para contactar)
        if (p.bajoRendimiento) {
          if (colNumber === 4 || colNumber === 10 || colNumber === 14) {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFFEF2F2" } // Rosa/rojo suave
            };
            cell.font = { name: "Arial", size: 9.5, bold: true, color: { argb: "FFDC2626" } };
          }
        } else if (p.porAcabar) {
          if (colNumber === 14) {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFEFF6FF" } // Azul suave
            };
            cell.font = { name: "Arial", size: 9.5, bold: true, color: { argb: "FF0F5FA6" } };
          }
        } else if (p.total_horas >= p.meta) {
          if (colNumber === 10 || colNumber === 14) {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF0FDF4" } // Verde suave
            };
            cell.font = { name: "Arial", size: 9.5, bold: true, color: { argb: "FF16A34A" } };
          }
        }
      });
    });

    // 4. Fila de Totales / Resumen
    if (listaPasantes.length > 0) {
      const totPres = Number(listaPasantes.reduce((acc, p) => acc + p.presencial, 0).toFixed(1));
      const totTele = Number(listaPasantes.reduce((acc, p) => acc + p.teletrabajo, 0).toFixed(1));
      const totExt = Number(listaPasantes.reduce((acc, p) => acc + p.horas_extra, 0).toFixed(1));
      const totGlobal = Number(listaPasantes.reduce((acc, p) => acc + p.total_horas, 0).toFixed(1));
      const avgPct = Math.round(listaPasantes.reduce((acc, p) => acc + p.porcentaje, 0) / listaPasantes.length);

      const summaryRow = sheet.addRow([
        "TOTAL",
        `${listaPasantes.length} Pasantes`,
        "",
        "",
        "",
        "",
        totPres,
        totTele,
        totExt,
        totGlobal,
        listaPasantes.length * 280,
        "",
        `${avgPct}% prom.`,
        `Alerta: ${countBajo} con < 100 hrs`
      ]);

      summaryRow.height = 25;
      summaryRow.eachCell((cell) => {
        cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF0F172A" } };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE2E8F0" }
        };
        cell.border = {
          top: { style: "medium", color: { argb: "FF0F5FA6" } },
          bottom: { style: "medium", color: { argb: "FF0F5FA6" } },
          left: { style: "thin", color: { argb: "FFCBD5E1" } },
          right: { style: "thin", color: { argb: "FFCBD5E1" } }
        };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
    }

    // Auto-ajustar anchos de columnas
    sheet.columns.forEach((column) => {
      let maxLen = 12;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const str = cell.value ? cell.value.toString() : "";
        if (str.length > maxLen) {
          maxLen = Math.min(str.length + 3, 40);
        }
      });
      column.width = maxLen;
    });

    // Enviar respuesta binaria Excel
    const filename = `Reporte_Pasantes_Monseley_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error al exportar Excel de pasantes:", err);
    res.status(500).send("Error al generar el archivo Excel de pasantes.");
  }
});

/**
 * Endpoints de compatibilidad heredados (para preservar cualquier llamada previa)
 */
router.get("/api/graficos/usuarios", async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_usuario, nombre FROM usuarios WHERE rol = 0 AND estado = 1 ORDER BY nombre`
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.json({ ok: false, msg: "Error cargando usuarios" });
  }
});

router.get("/api/graficos/line", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ ok: false, msg: "userId requerido" });

    const [rows] = await db.query(
      `SELECT
        YEARWEEK(a.fecha, 1) AS semana_key,
        MIN(a.fecha) AS semana_inicio,
        COALESCE(
          SUM(
            IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
               TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
               0)
          ), 0
        ) / 3600 AS horas_semana
      FROM asistencias a
      WHERE a.id_usuario = ? AND a.estado != 'ANULADO'
      GROUP BY semana_key
      ORDER BY semana_key ASC`,
      [userId]
    );

    let acc = 0;
    const labels = rows.map((r, i) => {
      const d = r.semana_inicio ? new Date(r.semana_inicio) : new Date();
      return `Sem ${i + 1} · ${d.toISOString().slice(0, 10)}`;
    });
    const horas = rows.map((r) => {
      const val = Math.round(Number(r.horas_semana || 0) * 10) / 10;
      acc += val;
      return val;
    });
    const acumulado = horas.map((h, i) => Math.round(horas.slice(0, i + 1).reduce((a, b) => a + b, 0) * 10) / 10);

    res.json({ ok: true, labels, horas, acumulado });
  } catch (e) {
    res.json({ ok: false, msg: "Error cargando series" });
  }
});

router.get("/api/graficos/pie", async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        u.id_usuario,
        u.nombre,
        COALESCE(
          SUM(
            IF(a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL,
               TIMESTAMPDIFF(SECOND, TIMESTAMP(a.fecha, a.hora_entrada), TIMESTAMP(a.fecha, a.hora_salida)),
               0)
          ), 0
        ) / 3600 AS horas
      FROM usuarios u
      LEFT JOIN asistencias a ON a.id_usuario = u.id_usuario AND a.estado != 'ANULADO'
      WHERE u.rol = 0 AND u.estado = 1
      GROUP BY u.id_usuario, u.nombre
      ORDER BY horas DESC, u.nombre ASC
    `);

    res.json({
      ok: true,
      labels: rows.map((r) => r.nombre),
      data: rows.map((r) => Math.round(Number(r.horas || 0) * 10) / 10)
    });
  } catch (e) {
    res.json({ ok: false, msg: "Error cargando pastel" });
  }
});

router.get("/api/graficos/kpi", async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS total FROM usuarios WHERE rol = 0 AND estado = 1`
    );
    res.json({ ok: true, total: rows?.[0]?.total || 0 });
  } catch (e) {
    res.json({ ok: false, msg: "Error KPI" });
  }
});

module.exports = router;
