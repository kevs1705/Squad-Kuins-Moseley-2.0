// sincronizar_biometrico.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./src/config/bd'); // Pool MySQL
const Zkteco = require('zkteco-js-with-restart');

const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.1.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;
const ID_LUGAR_DEFECTO = 3; // ID de lugar por defecto en la tabla lugares (Oficina / Biométrico)
const INTERVALO_MINUTOS = 5; // Frecuencia de sincronización en modo continuo
const LOG_FILE = path.join(__dirname, 'sincronizacion.log');

// Si se pasa --full procesa todo el historial, por defecto solo procesa el DÍA DE HOY (y ayer por margen)
const SINCRONIZAR_TODO = process.argv.includes('--full') || process.argv.includes('-f');

let sincronizandoEnCurso = false;

// Función de log dual (consola + archivo)
function logMensaje(texto) {
  const linea = `[${new Date().toLocaleString()}] ${texto}`;
  console.log(texto);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, path.join(__dirname, 'sincronizacion.prev.log'));
    }
    fs.appendFileSync(LOG_FILE, linea + '\n', 'utf8');
  } catch (e) { }
}

// Función para formatear fechas a YYYY-MM-DD y HH:mm:ss
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
    horaStr: `${hh}:${mi}:${ss}`,
    fechaHoraSql: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
  };
}

async function ejecutarSincronizacion() {
  if (sincronizandoEnCurso) {
    logMensaje('⚠️ Ciclo anterior aún en progreso. Omitiendo este turno...');
    return;
  }

  sincronizandoEnCurso = true;
  const horaInicio = new Date().toLocaleString();
  const modoFiltro = SINCRONIZAR_TODO ? 'HISTORIAL COMPLETO' : 'SOLO EL DÍA DE HOY';

  logMensaje('=================================================================');
  logMensaje(` 🔄 CICLO DE SINCRONIZACIÓN [${modoFiltro}] - [${horaInicio}]`);
  logMensaje('=================================================================');

  let dispositivoZk;

  try {
    // 1. CARGA DE DATOS DE MYSQL (1 SOLA CONSULTA OPTIMIZADA)
    logMensaje('1. Consultando catálogo y asistencias recientes en MySQL...');
    
    // 1A. Carreras y Lugares
    const [carrerasBD] = await db.query('SELECT id_carrera, nombre, siglas FROM carreras');
    const [lugaresBD] = await db.query('SELECT id_lugar, nombre FROM lugares WHERE id_lugar = ? LIMIT 1', [ID_LUGAR_DEFECTO]);
    const idLugarDefecto = lugaresBD.length > 0 ? lugaresBD[0].id_lugar : ID_LUGAR_DEFECTO;

    const mapCarrerasBySigla = new Map();
    carrerasBD.forEach(c => {
      if (c.siglas) mapCarrerasBySigla.set(String(c.siglas).trim().toUpperCase(), c.id_carrera);
    });

    // 1B. Usuarios
    const [usuariosBD] = await db.query(`
      SELECT u.id_usuario, u.nombre, u.apellido_paterno, u.CI, u.id_carrera, u.estado, u.rol, u.contrasena,
             c.siglas AS carrera_siglas 
      FROM usuarios u
      LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
    `);

    const mapUsuariosPorId = new Map();
    const mapUsuariosPorCI = new Map();
    usuariosBD.forEach(u => {
      if (u.id_usuario) mapUsuariosPorId.set(String(u.id_usuario), u);
      if (u.CI) mapUsuariosPorCI.set(String(u.CI).trim(), u);
    });

    // 1C. Traer solo asistencias de hoy (o últimos 2 días por margen) a memoria RAM
    const queryAsistencias = SINCRONIZAR_TODO
      ? `SELECT id_asistencia, id_usuario, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, hora_entrada, hora_salida, estado FROM asistencias`
      : `SELECT id_asistencia, id_usuario, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, hora_entrada, hora_salida, estado FROM asistencias WHERE fecha >= CURDATE() - INTERVAL 1 DAY`;

    const [asistenciasBD] = await db.query(queryAsistencias);

    const mapAsistenciasRAM = new Map();
    asistenciasBD.forEach(a => {
      const key = `${a.id_usuario}_${a.fecha}`;
      mapAsistenciasRAM.set(key, a);
    });

    // 2. CONEXIÓN AL BIOMÉTRICO K14
    logMensaje(`2. Conectando al equipo biométrico K14 en ${BIOMETRICO_IP}:${BIOMETRICO_PORT}...`);
    dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
    await dispositivoZk.createSocket();
    logMensaje('   --> ✅ Conexión TCP con K14 establecida.');

    // -----------------------------------------------------------------
    // ETAPA A: SINCRONIZACIÓN DE USUARIOS (Cloud <---> K14)
    // -----------------------------------------------------------------
    logMensaje('--- [ETAPA A: GESTIÓN Y SINCRONIZACIÓN DE USUARIOS] ---');
    const responseBio = await dispositivoZk.getUsers();
    const usuariosBio = responseBio.data || [];

    const mapBio = new Map();
    const mapBioByUid = new Map();

    usuariosBio.forEach(u => {
      const id = String(u.user_id || u.userId || u.uid || u.deviceUserId || '').trim();
      if (id && id !== 'undefined') mapBio.set(id, u);
      const uidNum = Number(u.uid);
      if (!isNaN(uidNum) && uidNum > 0) {
        mapBioByUid.set(uidNum, u);
      }
    });

    let creadosEnBD = 0;
    let creadosEnBio = 0;
    let editadosEnBio = 0;
    let eliminadosEnBio = 0;

    // A1. K14 -> BD (Nuevos usuarios inscritos en el biométrico)
    for (const [idBio, bioUser] of mapBio.entries()) {
      const existe = mapUsuariosPorId.has(idBio) || mapUsuariosPorCI.has(idBio);
      if (!existe) {
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

        const [resIns] = await db.query(
          `INSERT INTO usuarios (nombre, CI, universidad, id_carrera, celular, estado, rol, contrasena)
           VALUES (?, ?, 'UNIVALLE', ?, NULL, 1, ?, ?)`,
          [nombreTemp, ciTemp, idCarreraBD, rolBD, pwdTemp]
        );
        const nuevoU = { id_usuario: resIns.insertId, CI: ciTemp, nombre: nombreTemp };
        mapUsuariosPorId.set(String(resIns.insertId), nuevoU);
        mapUsuariosPorCI.set(String(ciTemp), nuevoU);
        creadosEnBD++;
        logMensaje(`   📥 Usuario importado a BD: [CI: ${ciTemp}] ${nombreTemp}`);
      }
    }

    // A2. BD -> K14 (Crear, Editar nombres/datos o Eliminar inactivos)
    for (const dbUser of usuariosBD) {
      const idSearchCI = String(dbUser.CI || '').trim();
      const idSearchId = String(dbUser.id_usuario || '').trim();
      const bioUid = Number(dbUser.id_usuario);
      const bioUserId = String(dbUser.id_usuario);

      const existingBio = (idSearchId && mapBio.get(idSearchId)) ||
                          (bioUid && mapBioByUid.get(bioUid)) ||
                          (idSearchCI && mapBio.get(idSearchCI)) || null;

      const nombreCompleto = `${dbUser.nombre || ''} ${dbUser.apellido_paterno || ''}`.trim();
      const bioName = nombreCompleto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .slice(0, 24) || `User_${bioUserId}`;

      let bioPassword = String(dbUser.contrasena || '123456').replace(/\D/g, '').slice(0, 8);
      if (!bioPassword) bioPassword = '123456';

      const bioRole = Number(dbUser.rol) === 1 ? 14 : 0;
      const bioDept = Number(dbUser.id_carrera) || 1;

      if (Number(dbUser.estado) === 1) {
        // Usuario ACTIVO: Crear o Editar
        if (!existingBio) {
          try {
            await dispositivoZk.setUser(bioUid, bioUserId, bioName, bioPassword, bioRole, 0, bioDept);
            mapBio.set(bioUserId, { uid: bioUid, userId: bioUserId, name: bioName, role: bioRole, password: bioPassword });
            creadosEnBio++;
            logMensaje(`   🚀 Usuario enviado al K14: [ID: ${bioUserId}] ${bioName}`);
          } catch (errSet) {
            logMensaje(`   ❌ Error enviando usuario al K14: ${errSet.message}`);
          }
        } else {
          // Ya existe en K14: Verificar si cambió nombre, rol, clave o carrera para EDITAR
          const currentBioName = String(existingBio.name || '').trim();
          const currentBioRole = Number(existingBio.role) || 0;
          const currentBioPass = String(existingBio.password || '').trim();

          const nameChanged = currentBioName !== bioName;
          const roleChanged = currentBioRole !== bioRole;
          const passChanged = bioPassword && currentBioPass && currentBioPass !== bioPassword;

          if (nameChanged || roleChanged || passChanged) {
            try {
              const targetUid = Number(existingBio.uid) || bioUid;
              await dispositivoZk.setUser(targetUid, bioUserId, bioName, bioPassword, bioRole, 0, bioDept);
              existingBio.name = bioName;
              existingBio.role = bioRole;
              existingBio.password = bioPassword;
              editadosEnBio++;
              logMensaje(`   ✏️ Usuario actualizado en K14: [ID: ${bioUserId}] "${currentBioName}" -> "${bioName}"`);
            } catch (errEdit) {
              logMensaje(`   ❌ Error editando usuario en K14: ${errEdit.message}`);
            }
          }
        }
      } else {
        // Usuario INACTIVO: Si aún está en K14, ELIMINARLO
        if (existingBio) {
          try {
            const targetUid = Number(existingBio.uid) || bioUid;
            await dispositivoZk.deleteUser(targetUid);
            mapBio.delete(bioUserId);
            mapBioByUid.delete(targetUid);
            if (idSearchCI) mapBio.delete(idSearchCI);
            eliminadosEnBio++;
            logMensaje(`   🗑️ Usuario inactivo eliminado del K14: [UID: ${targetUid}] ${nombreCompleto}`);
          } catch (errDel) {
            logMensaje(`   ❌ Error eliminando usuario inactivo del K14: ${errDel.message}`);
          }
        }
      }
    }

    logMensaje(`   --> Resumen Usuarios: K14 -> BD: ${creadosEnBD} | Creados en K14: ${creadosEnBio} | Editados en K14: ${editadosEnBio} | Eliminados de K14: ${eliminadosEnBio}`);

    // -----------------------------------------------------------------
    // ETAPA B: SINCRONIZACIÓN DE MARCAS (FILTRADO POR EL DÍA DE HOY)
    // -----------------------------------------------------------------
    logMensaje('--- [ETAPA B: MARCAS DE ASISTENCIA] ---');
    const responseAttendances = await dispositivoZk.getAttendances();
    const marcasBio = responseAttendances.data || [];
    logMensaje(`   --> Total registros en memoria del K14: ${marcasBio.length}`);

    // Obtener la fecha de hoy en formato YYYY-MM-DD
    const hoyObj = new Date();
    const { fecha: fechaHoyStr } = formatearFecha(hoyObj);
    
    // Ayer por margen de seguridad para turnos nocturnos
    const ayerObj = new Date();
    ayerObj.setDate(ayerObj.getDate() - 1);
    const { fecha: fechaAyerStr } = formatearFecha(ayerObj);

    // FILTRO: Solo procesar marcas de HOY (y ayer)
    const marcasValidas = marcasBio.filter(m => {
      const rawTime = m.record_time ?? m.recordTime ?? m.timestamp ?? m.time;
      const d = new Date(rawTime);
      if (isNaN(d.getTime())) return false;
      
      if (SINCRONIZAR_TODO) {
        return d.getFullYear() >= (hoyObj.getFullYear() - 1);
      } else {
        const { fecha: fechaMarca } = formatearFecha(d);
        return fechaMarca === fechaHoyStr || fechaMarca === fechaAyerStr;
      }
    });

    logMensaje(`   --> Marcas correspondientes a hoy a evaluar: ${marcasValidas.length}`);

    let marcasProcesadas = 0;
    let marcasOmitidas = 0;

    if (marcasValidas.length > 0) {
      marcasValidas.sort((a, b) => {
        const timeA = new Date(a.record_time || a.recordTime || a.timestamp).getTime();
        const timeB = new Date(b.record_time || b.recordTime || b.timestamp).getTime();
        return timeA - timeB;
      });

      for (const marca of marcasValidas) {
        try {
          const rawId = String(marca.user_id ?? marca.userId ?? marca.deviceUserId ?? marca.uid).trim();
          if (!rawId || rawId === 'undefined') {
            marcasOmitidas++;
            continue;
          }

          // Buscar usuario en RAM
          const usuarioEncontrado = mapUsuariosPorId.get(rawId) || mapUsuariosPorCI.get(rawId);
          if (!usuarioEncontrado) {
            marcasOmitidas++;
            continue;
          }

          const idUsuarioBD = usuarioEncontrado.id_usuario;
          const rawTime = marca.record_time ?? marca.recordTime ?? marca.timestamp ?? marca.time;
          const fechaHoraObj = new Date(rawTime);
          const { fecha, horaStr } = formatearFecha(fechaHoraObj);

          // Buscar en RAM
          const keyRAM = `${idUsuarioBD}_${fecha}`;
          const asis = mapAsistenciasRAM.get(keyRAM);

          if (asis) {
            if (asis.estado === 'EDITADO_ADMIN' || asis.estado === 'ANULADO') {
              marcasOmitidas++;
              continue;
            }

            if (!asis.hora_entrada) {
              await db.query(
                'UPDATE asistencias SET hora_entrada = ?, id_lugar = ? WHERE id_asistencia = ?',
                [horaStr, idLugarDefecto, asis.id_asistencia]
              );
              asis.hora_entrada = horaStr;
              marcasProcesadas++;
              logMensaje(`   ⏱️  Entrada registrada: Usuario ID ${idUsuarioBD} a las ${horaStr}`);
            } else if (horaStr > asis.hora_entrada) {
              if (!asis.hora_salida || horaStr > asis.hora_salida) {
                await db.query(
                  'UPDATE asistencias SET hora_salida = ?, id_lugar = ? WHERE id_asistencia = ?',
                  [horaStr, idLugarDefecto, asis.id_asistencia]
                );
                asis.hora_salida = horaStr;
                marcasProcesadas++;
                logMensaje(`   ⏱️  Salida actualizada: Usuario ID ${idUsuarioBD} a las ${horaStr}`);
              } else {
                marcasOmitidas++;
              }
            } else {
              marcasOmitidas++;
            }
          } else {
            // Primera entrada del día
            const [insRes] = await db.query(
              'INSERT INTO asistencias (id_usuario, id_lugar, fecha, hora_entrada, estado) VALUES (?, ?, ?, ?, ?)',
              [idUsuarioBD, idLugarDefecto, fecha, horaStr, 'PRESENTE']
            );
            mapAsistenciasRAM.set(keyRAM, {
              id_asistencia: insRes.insertId,
              id_usuario: idUsuarioBD,
              fecha: fecha,
              hora_entrada: horaStr,
              hora_salida: null,
              estado: 'PRESENTE'
            });
            marcasProcesadas++;
            logMensaje(`   ⏱️  Nueva entrada del día: Usuario ID ${idUsuarioBD} a las ${horaStr}`);
          }
        } catch (errReg) {
          // Ignorar silenciosamente si ya estaba duplicada por clave única
          if (errReg.code !== 'ER_DUP_ENTRY') {
            logMensaje(`   ❌ Error en marca: ${errReg.message}`);
          }
          marcasOmitidas++;
        }
      }
    }

    logMensaje(`==================== RESUMEN GENERAL ====================`);
    logMensaje(`📥 Usuarios K14 -> BD:        ${creadosEnBD}`);
    logMensaje(`🚀 Usuarios BD -> K14 creados:${creadosEnBio}`);
    logMensaje(`✏️  Usuarios K14 actualizados: ${editadosEnBio}`);
    logMensaje(`🗑️  Usuarios K14 eliminados:   ${eliminadosEnBio}`);
    logMensaje(`⏱️  Marcas nuevas procesadas:  ${marcasProcesadas}`);
    logMensaje(`⏭️  Marcas ya registradas:     ${marcasOmitidas}`);
    logMensaje(`=========================================================\n`);

  } catch (error) {
    logMensaje(`❌ Error durante la sincronización: ${error?.message || error}`);
  } finally {
    if (dispositivoZk) {
      try { await dispositivoZk.disconnect(); } catch (e) { }
    }
    sincronizandoEnCurso = false;
  }
}

// Control de modo de ejecución (Manual o Bucle Continuo)
const esDaemon = process.argv.includes('--daemon') || process.argv.includes('-d');

if (esDaemon) {
  logMensaje(`🤖 Modo Servicio activado: sincronización periódica cada ${INTERVALO_MINUTOS} minutos.`);
  ejecutarSincronizacion();
  setInterval(ejecutarSincronizacion, INTERVALO_MINUTOS * 60 * 1000);
} else {
  ejecutarSincronizacion().then(() => {
    process.exit(0);
  });
}