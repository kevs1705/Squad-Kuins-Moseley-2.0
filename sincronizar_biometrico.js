// sincronizar_biometrico.js
require('dotenv').config();
const db = require('./src/config/bd'); // Pool MySQL
const Zkteco = require('zkteco-js-with-restart');

const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.0.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;

async function sincronizarBidireccional() {
  console.log('=================================================================');
  console.log(' 🔄 SINCRONIZACIÓN BD <---> K14 (Con Tabla Carreras / Siglas) ');
  console.log('=================================================================\n');

  let dispositivoZk;

  try {
    // 1. CARGAR LISTA DE CARRERAS (Para mapear siglas <-> id_carrera)
    console.log('1. Cargando catálogo de carreras...');
    const [carrerasBD] = await db.query('SELECT id_carrera, nombre, siglas FROM carreras');
    
    // Crear mapas de búsqueda rápida por ID y por Siglas
    const mapCarrerasById = new Map();
    const mapCarrerasBySigla = new Map();

    carrerasBD.forEach(c => {
      mapCarrerasById.set(Number(c.id_carrera), c);
      if (c.siglas) {
        mapCarrerasBySigla.set(String(c.siglas).trim().toUpperCase(), c.id_carrera);
      }
    });
    console.log(`   --> ${carrerasBD.length} carrera(s) registradas en BD.\n`);

    // 2. OBTENER USUARIOS DE MYSQL (Con JOIN a carreras)
    console.log('2. Consultando usuarios en MySQL...');
    const [usuariosBD] = await db.query(`
      SELECT u.*, c.siglas AS carrera_siglas 
      FROM usuarios u
      LEFT JOIN carreras c ON u.id_carrera = c.id_carrera
    `);
    console.log(`   --> ${usuariosBD.length} usuario(s) en MySQL.\n`);

    // 3. OBTENER USUARIOS DEL BIOMÉTRICO K14
    console.log('3. Conectando al biométrico K14...');
    dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
    await dispositivoZk.createSocket();

    const responseBio = await dispositivoZk.getUsers();
    const usuariosBio = responseBio.data || [];
    console.log(`   --> ${usuariosBio.length} usuario(s) en el K14.\n`);

    // 4. MAPEAR AMBOS LADOS (id_usuario <-> uid)
    const mapBD = new Map();
    usuariosBD.forEach(u => mapBD.set(Number(u.id_usuario), u));

    const mapBio = new Map();
    usuariosBio.forEach(u => {
      const id = Number(u.uid || u.userId);
      if (id) mapBio.set(id, u);
    });

    let creadosEnBD = 0;
    let creadosEnBio = 0;
    let coinciden = 0;

    // -----------------------------------------------------------------
    // A. K14 -> MySQL (Jalar usuarios nuevos del biométrico)
    // -----------------------------------------------------------------
    console.log('4. Verificando K14 -> MySQL...');
    for (const [idBio, bioUser] of mapBio.entries()) {
      if (!mapBD.has(idBio)) {
        const nombreTemp = String(bioUser.name || `Usuario_${idBio}`).trim().slice(0, 100);
        const pwdTemp = String(bioUser.password || '123456');
        const ciTemp = `BIO-${idBio}`;

        // Obtener el departamento (sigla) ingresado en el K14
        const deptoBio = String(
          bioUser.dept || bioUser.department || bioUser.deptId || bioUser.group || ''
        ).trim().toUpperCase();

        // Buscar el id_carrera según las siglas traídas del K14 (o asigna NULL / primera carrera por defecto)
        const idCarreraBD = mapCarrerasBySigla.get(deptoBio) || (carrerasBD[0]?.id_carrera || null);
        const rolBD = Number(bioUser.role) > 0 ? 1 : 0;

        console.log(`   ➕ Jalando a BD: [ID: ${idBio}] - "${nombreTemp}" | Siglas K14: "${deptoBio}" -> id_carrera: ${idCarreraBD}`);

        await db.query(
          `INSERT INTO usuarios (id_usuario, nombre, CI, universidad, id_carrera, celular, estado, rol, contrasena)
           VALUES (?, ?, ?, 'UNIVALLE', ?, NULL, 1, ?, ?)`,
          [idBio, nombreTemp, ciTemp, idCarreraBD, rolBD, pwdTemp]
        );
        creadosEnBD++;
      }
    }

    // -----------------------------------------------------------------
    // B. MySQL -> K14 (Exportar usuarios activos a la memoria del K14)
    // -----------------------------------------------------------------
    console.log('\n5. Verificando MySQL -> K14...');
    for (const [idBD, dbUser] of mapBD.entries()) {
      if (!mapBio.has(idBD)) {
        if (Number(dbUser.estado) === 1) {
          const siglaCarrera = String(dbUser.carrera_siglas || 'SIS').trim();
          console.log(`   🚀 Enviando a K14: [ID: ${idBD}] - "${dbUser.nombre}" | Depto/Siglas: "${siglaCarrera}"`);

          const bioUid = Number(idBD);
          const bioUserId = String(idBD);
          const bioName = String(dbUser.nombre || 'Usuario').trim().slice(0, 24);

          let bioPassword = String(dbUser.contrasena || '123456').replace(/\D/g, '').slice(0, 8);
          if (!bioPassword) bioPassword = '123456';

          const bioRole = Number(dbUser.rol) === 1 ? 14 : 0;
          const bioCard = 0;

          await dispositivoZk.setUser(
            bioUid,
            bioUserId,
            bioName,
            bioPassword,
            bioRole,
            bioCard
          );
          creadosEnBio++;
        }
      } else {
        coinciden++;
      }
    }

    console.log('\n==================== RESUMEN DE RECONCILIACIÓN ====================');
    console.log(`📥 Importados de K14 a MySQL:        ${creadosEnBD}`);
    console.log(`🚀 Exportados de MySQL a K14:        ${creadosEnBio}`);
    console.log(`🆗 Perfectamente sincronizados:       ${coinciden}`);
    console.log('===================================================================\n');

  } catch (error) {
    console.error('❌ Error durante la sincronización:', error?.message || error);
  } finally {
    if (dispositivoZk) {
      try { await dispositivoZk.disconnect(); } catch (e) {}
    }
    process.exit(0);
  }
}

sincronizarBidireccional();