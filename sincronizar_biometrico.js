// sincronizar_biometrico.js
require('dotenv').config();
const db = require('./src/config/bd'); // Pool MySQL
const Zkteco = require('zkteco-js-with-restart');

const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.0.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;
const ID_LUGAR_DEFECTO = 3; // ID de lugar por defecto en la tabla lugares

// Función para formatear fechas a YYYY-MM-DD y YYYY-MM-DD HH:mm:ss
function formatearFecha(fechaObj) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = fechaObj.getFullYear();
  const mm = pad(fechaObj.getMonth() + 1);
  const dd = pad(fechaObj.getDate());
  const hh = pad(fechaObj.getHours());
  const mi = pad(fechaObj.getMinutes());
  const ss = pad(fechaObj.getSeconds());

  return {
    fecha: `${yyyy}-${mm}-${dd}`,
    fechaHoraSql: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
  };
}

async function sincronizarBiometricoCompleto() {
  console.log('=================================================================');
  console.log(' 🔄 SINCRONIZACIÓN INTEGRAL: USUARIOS Y ASISTENCIAS K14 <---> BD ');
  console.log('=================================================================\n');

  let dispositivoZk;

  try {
    console.log('1. Cargando catálogo de carreras y lugares...');
    const [carrerasBD] = await db.query('SELECT id_carrera, nombre, siglas FROM carreras');
    const [lugaresBD] = await db.query('SELECT id_lugar, nombre FROM lugares WHERE id_lugar = ? LIMIT 1', [ID_LUGAR_DEFECTO]);
    const idLugarDefecto = lugaresBD.length > 0 ? lugaresBD[0].id_lugar : ID_LUGAR_DEFECTO;

    const mapCarrerasBySigla = new Map();
    carrerasBD.forEach(c => {
      if (c.siglas) mapCarrerasBySigla.set(String(c.siglas).trim().toUpperCase(), c.id_carrera);
    });

    console.log('2. Consultando usuarios registrados en MySQL...');
    const [usuariosBD] = await db.query(`
      SELECT u.*, c.siglas AS carrera_siglas 
      FROM usuarios u
      LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
    `);

    console.log('3. Conectando al equipo biométrico K14...');
    dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
    await dispositivoZk.createSocket();
    console.log('   --> Conexión TCP establecida.\n');

    // -----------------------------------------------------------------
    // ETAPA A: SINCRONIZACIÓN DE USUARIOS
    // -----------------------------------------------------------------
    console.log('--- [ETAPA A: SINCRONIZACIÓN DE USUARIOS] ---');
    const responseBio = await dispositivoZk.getUsers();
    const usuariosBio = responseBio.data || [];

    // Mapear usuarios de la BD por id_usuario y por CI para búsqueda rápida
    const mapBD = new Map();
    usuariosBD.forEach(u => {
      if (u.id_usuario) mapBD.set(String(u.id_usuario), u);
      if (u.CI) mapBD.set(String(u.CI).trim(), u);
    });

    const mapBio = new Map();
    usuariosBio.forEach(u => {
      const id = String(u.user_id || u.userId || u.uid || u.deviceUserId || '').trim();
      if (id && id !== 'undefined') mapBio.set(id, u);
      const uid = String(u.uid || '').trim();
      if (uid && uid !== 'undefined') mapBio.set(uid, u);
    });

    let creadosEnBD = 0;
    let creadosEnBio = 0;

    // 1. Usuarios en Biométrico que NO están en la BD -> Importar a BD
    for (const [idBio, bioUser] of mapBio.entries()) {
      if (!mapBD.has(idBio)) {
        const nombreTemp = String(bioUser.name || `Usuario_${idBio}`).trim().slice(0, 100);
        const pwdTemp = String(bioUser.password || '123456');
        const ciTemp = idBio;

        const deptoBioRaw = bioUser.dept || bioUser.department || bioUser.deptId || bioUser.group || 0;
        let idCarreraBD = null;

        if (!isNaN(deptoBioRaw) && Number(deptoBioRaw) > 0) {
          idCarreraBD = Number(deptoBioRaw);
        } else {
          const deptoBioSigla = String(deptoBioRaw).trim().toUpperCase();
          idCarreraBD = mapCarrerasBySigla.get(deptoBioSigla) || (carrerasBD[0]?.id_carrera || null);
        }

        const rolBD = Number(bioUser.role) > 0 ? 1 : 0;

        await db.query(
          `INSERT INTO usuarios (nombre, CI, universidad, id_carrera, celular, estado, rol, contrasena)
           VALUES (?, ?, 'UNIVALLE', ?, NULL, 1, ?, ?)`,
          [nombreTemp, ciTemp, idCarreraBD, rolBD, pwdTemp]
        );
        // Actualizar mapBD local para evitar duplicados en la misma corrida
        mapBD.set(String(ciTemp), { CI: ciTemp, nombre: nombreTemp });
        creadosEnBD++;
      }
    }

    // 2. Usuarios en BD que NO están en Biométrico -> Exportar a Biométrico
    for (const dbUser of usuariosBD) {
      const idSearchCI = String(dbUser.CI || '').trim();
      const idSearchId = String(dbUser.id_usuario || '').trim();

      const yaEnBio = (idSearchCI && mapBio.has(idSearchCI)) || (idSearchId && mapBio.has(idSearchId));

      if (!yaEnBio && Number(dbUser.estado) === 1) {
        const bioUid = Number(dbUser.id_usuario);
        const bioUserId = String(dbUser.CI || dbUser.id_usuario).trim().slice(0, 9);
        // Normalizar nombre sin acentos para compatibilidad con el firmware ZK
        const bioName = String(dbUser.nombre || 'Usuario')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
          .slice(0, 24);

        let bioPassword = String(dbUser.contrasena || '123456').replace(/\D/g, '').slice(0, 8);
        if (!bioPassword) bioPassword = '123456';

        const bioRole = Number(dbUser.rol) === 1 ? 14 : 0;

        try {
          await dispositivoZk.setUser(bioUid, bioUserId, bioName, bioPassword, bioRole, 0);
          mapBio.set(bioUserId, { uid: bioUid, userId: bioUserId, name: bioName });
          creadosEnBio++;
          console.log(`   ✅ Usuario enviado al K14: [ID/CI: ${bioUserId}] ${bioName}`);
        } catch (errSet) {
          console.error(`   ❌ Error enviando usuario ${bioUserId} (${bioName}) al K14:`, errSet.message);
        }
      }
    }

    console.log(`   --> Usuarios K14 -> BD: ${creadosEnBD} | BD -> K14: ${creadosEnBio}\n`);

    // -----------------------------------------------------------------
    // ETAPA B: SINCRONIZACIÓN DE MARCAS
    // -----------------------------------------------------------------
    console.log('--- [ETAPA B: SINCRONIZACIÓN DE MARCAS DE ASISTENCIA] ---');

    const responseAttendances = await dispositivoZk.getAttendances();
    const marcasBio = responseAttendances.data || [];
    console.log(`   --> Total de marcas extraídas del K14: ${marcasBio.length}`);

    // Filtrar únicamente las marcas correspondientes al año 2026
    const marcasBio2026 = marcasBio.filter(m => {
      const rawTime = m.record_time ?? m.recordTime ?? m.timestamp ?? m.time;
      const d = new Date(rawTime);
      return !isNaN(d.getTime()) && d.getFullYear() === 2026;
    });
    console.log(`   --> Total de marcas del año 2026 a procesar: ${marcasBio2026.length}`);

    let marcasProcesadas = 0;
    let marcasOmitidas = marcasBio.length - marcasBio2026.length;

    if (marcasBio2026.length > 0) {
      // Ordenar marcas de más antigua a más reciente
      marcasBio2026.sort((a, b) => {
        const timeA = new Date(a.record_time || a.recordTime || a.timestamp).getTime();
        const timeB = new Date(b.record_time || b.recordTime || b.timestamp).getTime();
        return timeA - timeB;
      });

      for (const marca of marcasBio2026) {
        try {
          const rawId = String(marca.user_id ?? marca.userId ?? marca.deviceUserId ?? marca.uid).trim();

          if (!rawId || rawId === 'undefined') {
            console.log(`   ⚠️ ID inválido en marca:`, marca);
            marcasOmitidas++;
            continue;
          }

          // 1. Buscar el id_usuario real en MySQL por id_usuario O por CI
          const [checkUser] = await db.query(
            'SELECT id_usuario FROM usuarios WHERE id_usuario = ? OR CI = ? LIMIT 1',
            [rawId, rawId]
          );

          if (checkUser.length === 0) {
            console.log(`   ⚠️ El usuario con ID/CI '${rawId}' no existe en la base de datos MySQL.`);
            marcasOmitidas++;
            continue;
          }

          const idUsuarioBD = checkUser[0].id_usuario;

          // Parseo de fecha
          const rawTime = marca.record_time ?? marca.recordTime ?? marca.timestamp ?? marca.time;
          const fechaHoraObj = new Date(rawTime);

          if (isNaN(fechaHoraObj.getTime()) || fechaHoraObj.getFullYear() !== 2026) {
            console.log(`   ⚠️ Fecha no válida/fuera de 2026 para el usuario ${rawId}:`, rawTime);
            marcasOmitidas++;
            continue;
          }

          const { fecha, fechaHoraSql } = formatearFecha(fechaHoraObj);
          const horaStr = fechaHoraSql.split(' ')[1] || '00:00:00';

          // Asignar idLugarDefecto (3 - Oficina / Biométrico)
          const idLugar = idLugarDefecto;

          // Insertar / Actualizar asistencia unificando hora_entrada y hora_salida
          const queryAsistencia = `
            INSERT INTO asistencias (
              id_usuario, 
              id_lugar, 
              fecha, 
              hora_entrada,
              fecha_hora_biometrico_entrada, 
              estado
            ) VALUES (?, ?, ?, ?, ?, 'PRESENTE')
            ON DUPLICATE KEY UPDATE
              id_lugar = VALUES(id_lugar),
              hora_entrada = COALESCE(hora_entrada, VALUES(hora_entrada)),
              hora_salida = IF(
                (hora_entrada IS NOT NULL AND VALUES(hora_entrada) > hora_entrada) OR
                (fecha_hora_biometrico_entrada IS NOT NULL AND VALUES(fecha_hora_biometrico_entrada) > fecha_hora_biometrico_entrada),
                VALUES(hora_entrada),
                hora_salida
              ),
              fecha_hora_biometrico_entrada = COALESCE(fecha_hora_biometrico_entrada, VALUES(fecha_hora_biometrico_entrada)),
              fecha_hora_biometrico_salida = IF(
                fecha_hora_biometrico_entrada IS NOT NULL AND VALUES(fecha_hora_biometrico_entrada) > fecha_hora_biometrico_entrada,
                VALUES(fecha_hora_biometrico_entrada),
                fecha_hora_biometrico_salida
              );
          `;

          await db.query(queryAsistencia, [idUsuarioBD, idLugar, fecha, horaStr, fechaHoraSql]);
          marcasProcesadas++;

        } catch (errReg) {
          console.error(`   ❌ Error SQL insertando marca de usuario ${marca.user_id}: ${errReg.message}`);
          marcasOmitidas++;
        }
      }
    }

    console.log(`\n==================== RESUMEN GENERAL ====================`);
    console.log(`📥 Usuarios importados de K14 a BD: ${creadosEnBD}`);
    console.log(`🚀 Usuarios exportados de BD a K14: ${creadosEnBio}`);
    console.log(`⏱️  Marcas procesadas con éxito:     ${marcasProcesadas}`);
    console.log(`⚠️  Marcas omitidas o con error:     ${marcasOmitidas}`);
    console.log('=========================================================\n');

  } catch (error) {
    console.error('❌ Error crítico durante el proceso:', error?.message || error);
  } finally {
    if (dispositivoZk) {
      try { await dispositivoZk.disconnect(); } catch (e) { }
    }
    process.exit(0);
  }
}

sincronizarBiometricoCompleto();