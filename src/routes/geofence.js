const express = require('express');
const router = express.Router();
const db = require('../config/bd.js');
const { distanceMeters } = require('../middleware/geofence');
const { requireAuth } = require('../middleware/auth.js');

// GET: Cargar la vista de geocerca con los lugares activos o modo teletrabajo
router.get('/geofence', requireAuth, async (req, res) => {
  const redirect = req.query.redirect || '/usuario/reporte';
  const userId = req.session.user.id || req.session.user.id_usuario;

  try {
    // 1. Verificar si el usuario tiene permiso de teletrabajo aprobado para hoy
    const [teletrabajoRows] = await db.query(
      `SELECT id_solicitud, direccion_remota, 
              TIME_FORMAT(hora_inicio, '%H:%i') AS hora_inicio, 
              TIME_FORMAT(hora_fin, '%H:%i') AS hora_fin,
              motivo
       FROM solicitudes_teletrabajo
       WHERE id_usuario = ? AND fecha_solicitada = CURDATE() AND estado = 2
       LIMIT 1`,
      [userId]
    );
    const teletrabajoHoy = teletrabajoRows.length > 0 ? teletrabajoRows[0] : null;

    // 2. Obtener los lugares activos de la base de datos (excluyendo tipo TELETRABAJO y coordenadas 0,0)
    const [lugares] = await db.query(
      "SELECT id_lugar, nombre, latitud, longitud, radio_metros FROM lugares WHERE estado = 'ACTIVO' AND tipo != 'TELETRABAJO' AND latitud != 0 AND longitud != 0"
    );

    // Renderizar la vista pasando lugares y estado de teletrabajo
    res.render('geofence', { redirect, lugares: lugares || [], teletrabajoHoy });
  } catch (error) {
    console.error('Error al cargar geocerca:', error);
    res.status(500).send('Error interno del servidor al cargar geocerca.');
  }
});

// POST API: Validar coordenadas del usuario (Modo Teletrabajo o Lugares activos)
router.post('/api/geofence/verify', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, msg: 'Sesión no iniciada.' });
  }
  const userId = req.session.user.id || req.session.user.id_usuario;
  const { lat, lng, accuracy } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    return res.status(400).json({ ok: false, msg: 'Parámetros de ubicación inválidos' });
  }

  const hardMaxAccuracy = 200; // metros
  if (accuracy > hardMaxAccuracy) {
    return res.status(400).json({ ok: false, msg: `Señal GPS imprecisa (${Math.round(accuracy)}m). Intenta en un lugar con mejor cobertura GPS o activa el Wi-Fi.` });
  }

  try {
    // 1. Verificar si el usuario tiene teletrabajo aprobado para hoy
    const [teletrabajoRows] = await db.query(
      `SELECT id_solicitud, direccion_remota, motivo
       FROM solicitudes_teletrabajo
       WHERE id_usuario = ? AND fecha_solicitada = CURDATE() AND estado = 2
       LIMIT 1`,
      [userId]
    );
    const teletrabajoHoy = teletrabajoRows.length > 0 ? teletrabajoRows[0] : null;

    // MODO TELETRABAJO
    if (teletrabajoHoy) {
      // Buscar o asegurar que exista el lugar 'Teletrabajo' en la tabla lugares
      let idLugarTeletrabajo = null;
      try {
        const [lugarTele] = await db.query(
          "SELECT id_lugar FROM lugares WHERE nombre = 'Teletrabajo' LIMIT 1"
        );
        if (lugarTele && lugarTele.length > 0) {
          idLugarTeletrabajo = lugarTele[0].id_lugar;
        } else {
          const [insertLugar] = await db.query(
            "INSERT INTO lugares (nombre, tipo, direccion, estado, latitud, longitud, radio_metros) VALUES ('Teletrabajo', 'TELETRABAJO', 'Ubicación Remota', 'ACTIVO', 0, 0, 0)"
          );
          idLugarTeletrabajo = insertLugar.insertId;
        }
      } catch (errLugar) {
        console.warn('Fallback al obtener id_lugar para teletrabajo:', errLugar.message);
        const [primerLugar] = await db.query("SELECT id_lugar FROM lugares LIMIT 1");
        idLugarTeletrabajo = primerLugar[0]?.id_lugar || 1;
      }

      req.session.geofence = {
        ok: true,
        esTeletrabajo: true,
        id_solicitud_teletrabajo: teletrabajoHoy.id_solicitud,
        id_lugar: idLugarTeletrabajo,
        nombre_lugar: `Teletrabajo: ${teletrabajoHoy.direccion_remota || 'Ubicación Remota'}`,
        lat,
        lng,
        accuracy: Math.round(accuracy),
        distance: 0,
        until: Date.now() + (10 * 60 * 60 * 1000) // Válido por 10 horas
      };

      return req.session.save((err) => {
        if (err) {
          console.error('Error guardando sesión de geocerca:', err);
          return res.status(500).json({ ok: false, msg: 'Error al guardar la sesión.' });
        }

        return res.json({
          ok: true,
          esTeletrabajo: true,
          msg: `Ubicación remota verificada para Teletrabajo (${teletrabajoHoy.direccion_remota || 'Remoto'}).`,
          lugar: `🏠 Teletrabajo (${teletrabajoHoy.direccion_remota || 'Remoto'})`,
          distanceM: 0,
          accuracyM: Math.round(accuracy)
        });
      });
    }

    // MODO PRESENCIAL NORMAL: Obtener lugares activos desde la base de datos
    const [lugares] = await db.query(
      "SELECT id_lugar, nombre, latitud, longitud, radio_metros FROM lugares WHERE estado = 'ACTIVO'"
    );

    if (!lugares || lugares.length === 0) {
      return res.status(400).json({ ok: false, msg: 'No existen ubicaciones activas autorizadas en el sistema.' });
    }

    // Verificar si el usuario está dentro del radio de alguna obra/oficina
    let lugarValido = null;
    let menorDistancia = Infinity;

    for (const lugar of lugares) {
      const latLugar = parseFloat(lugar.latitud);
      const lngLugar = parseFloat(lugar.longitud);
      const radioLugar = parseFloat(lugar.radio_metros);

      const dist = distanceMeters(latLugar, lngLugar, lat, lng);
      const dentro = dist <= radioLugar;

      if (dentro) {
        lugarValido = { ...lugar, distanciaCalculada: dist };
        break;
      }

      if (dist < menorDistancia) {
        menorDistancia = dist;
      }
    }

    if (!lugarValido) {
      return res.status(403).json({
        ok: false,
        msg: `Fuera de zona autorizada. Distancia más cercana: ${Math.round(menorDistancia)}m.`
      });
    }

    // Guardar pase presencial en la sesión
    req.session.geofence = {
      ok: true,
      esTeletrabajo: false,
      id_solicitud_teletrabajo: null,
      id_lugar: lugarValido.id_lugar,
      nombre_lugar: lugarValido.nombre,
      lat,
      lng,
      accuracy: Math.round(accuracy),
      distance: Math.round(lugarValido.distanciaCalculada),
      until: Date.now() + (8 * 60 * 60 * 1000)
    };

    req.session.save((err) => {
      if (err) {
        console.error('Error al guardar sesión de geocerca:', err);
        return res.status(500).json({ ok: false, msg: 'No se pudo guardar la sesión.' });
      }

      return res.json({
        ok: true,
        esTeletrabajo: false,
        msg: `Ubicación verificada en "${lugarValido.nombre}"`,
        lugar: lugarValido.nombre,
        distanceM: Math.round(lugarValido.distanciaCalculada),
        accuracyM: Math.round(accuracy)
      });
    });

  } catch (error) {
    console.error('Error en verificación de geocerca:', error);
    return res.status(500).json({ ok: false, msg: 'Error de base de datos.' });
  }
});

// POST API: Registrar la Entrada/Salida en la tabla asistencias
router.post('/api/geofence/register', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, msg: 'Sesión no iniciada.' });
  }

  const { tipo, fechaCliente, horaCliente } = req.body;
  
  if (tipo !== 'entrada' && tipo !== 'salida') {
    return res.status(400).json({ ok: false, msg: 'Tipo de asistencia inválido.' });
  }

  const regexFecha = /^\d{4}-\d{2}-\d{2}$/;
  const regexHora = /^\d{2}:\d{2}:\d{2}$/;

  let fechaUsar = fechaCliente;
  let horaUsar = horaCliente;

  if (!fechaUsar || !regexFecha.test(fechaUsar) || !horaUsar || !regexHora.test(horaUsar)) {
    const ahoraRegion = new Date();
    fechaUsar = ahoraRegion.toLocaleDateString('sv-SE', { timeZone: 'America/La_Paz' });
    horaUsar = ahoraRegion.toLocaleTimeString('en-GB', { timeZone: 'America/La_Paz' });
  }

  if (!req.session.geofence || !req.session.geofence.ok || Date.now() > req.session.geofence.until) {
    return res.status(403).json({ ok: false, msg: 'Ubicación no verificada o sesión de ubicación expirada.' });
  }

  const userId = req.session.user.id || req.session.user.id_usuario;
  const esTeletrabajo = !!req.session.geofence.esTeletrabajo;
  const idLugar = req.session.geofence.id_lugar;
  const idSolicitudTeletrabajo = esTeletrabajo ? req.session.geofence.id_solicitud_teletrabajo : null;
  const modalidad = esTeletrabajo ? 'TELETRABAJO' : 'PRESENCIAL';
  const estadoAsistencia = esTeletrabajo ? 'OBSERVADO' : 'PRESENTE';
  const lat = req.session.geofence.lat || null;
  const lng = req.session.geofence.lng || null;

  try {
    // Buscar si ya existe una asistencia para la fecha
    const [existing] = await db.query(
      'SELECT id_asistencia, hora_entrada, hora_salida FROM asistencias WHERE id_usuario = ? AND fecha = ? LIMIT 1',
      [userId, fechaUsar]
    );

    let asistenciaId = null;

    if (existing && existing.length > 0) {
      asistenciaId = existing[0].id_asistencia;
      if (tipo === 'entrada') {
        await db.query(
          `UPDATE asistencias 
           SET hora_entrada = ?, id_lugar = ?, estado = ?
           WHERE id_asistencia = ?`,
          [horaUsar, idLugar, estadoAsistencia, asistenciaId]
        );
      } else {
        await db.query(
          `UPDATE asistencias 
           SET hora_salida = ?, id_lugar = COALESCE(?, id_lugar), 
               estado = IF(? = 'TELETRABAJO', 'OBSERVADO', estado)
           WHERE id_asistencia = ?`,
          [horaUsar, idLugar, modalidad, asistenciaId]
        );
      }
    } else {
      // Insertar nuevo registro en tabla pura asistencias
      if (tipo === 'entrada') {
        const [ins] = await db.query(
          `INSERT INTO asistencias (id_usuario, id_lugar, fecha, hora_entrada, estado) 
           VALUES (?, ?, ?, ?, ?)`,
          [userId, idLugar, fechaUsar, horaUsar, estadoAsistencia]
        );
        asistenciaId = ins.insertId;
      } else {
        const [ins] = await db.query(
          `INSERT INTO asistencias (id_usuario, id_lugar, fecha, hora_salida, estado) 
           VALUES (?, ?, ?, ?, ?)`,
          [userId, idLugar, fechaUsar, horaUsar, estadoAsistencia]
        );
        asistenciaId = ins.insertId;
      }
    }

    // Guardar / Actualizar registro en la tabla satélite asistencias_geo
    if (asistenciaId) {
      if (tipo === 'entrada') {
        await db.query(`
          INSERT INTO asistencias_geo 
            (id_asistencia, modalidad, id_solicitud_teletrabajo, lat_entrada, lng_entrada, precision_entrada_m)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            modalidad = VALUES(modalidad),
            id_solicitud_teletrabajo = VALUES(id_solicitud_teletrabajo),
            lat_entrada = VALUES(lat_entrada),
            lng_entrada = VALUES(lng_entrada),
            precision_entrada_m = VALUES(precision_entrada_m)
        `, [asistenciaId, modalidad, idSolicitudTeletrabajo, lat, lng, req.session.geofence.accuracy || null]);
      } else {
        await db.query(`
          INSERT INTO asistencias_geo 
            (id_asistencia, modalidad, id_solicitud_teletrabajo, lat_salida, lng_salida, precision_salida_m)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            modalidad = VALUES(modalidad),
            id_solicitud_teletrabajo = VALUES(id_solicitud_teletrabajo),
            lat_salida = VALUES(lat_salida),
            lng_salida = VALUES(lng_salida),
            precision_salida_m = VALUES(precision_salida_m)
        `, [asistenciaId, modalidad, idSolicitudTeletrabajo, lat, lng, req.session.geofence.accuracy || null]);
      }
    }

    const msgRes = esTeletrabajo
      ? (tipo === 'salida' 
          ? `Salida de Teletrabajo registrada. Recuerda completar tu bitácora de tareas para enviar a revisión.` 
          : `Entrada de Teletrabajo registrada exitosamente. Jornada en observación.`)
      : `Se registró tu ${tipo} con éxito.`;

    return res.json({
      ok: true,
      esTeletrabajo,
      msg: msgRes,
      hora: horaUsar
    });

  } catch (error) {
    console.error('Error al registrar asistencia en BD:', error);
    return res.status(500).json({ ok: false, msg: 'Error al guardar la asistencia en la base de datos.' });
  }
});

module.exports = router;