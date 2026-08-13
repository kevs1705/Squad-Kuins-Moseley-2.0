// sincronizar_biometrico.js
require('dotenv').config();
const db = require('./src/config/bd'); // Pool MySQL
const Zkteco = require('zkteco-js-with-restart');

const BIOMETRICO_IP = process.env.BIOMETRICO_IP || '192.168.0.250';
const BIOMETRICO_PORT = Number(process.env.BIOMETRICO_PORT) || 4370;

async function sincronizarBidireccional() {
  console.log('=================================================================');
  console.log(' 🔄 SINCRONIZACIÓN BD (id_usuario) <---> K14 (uid) ');
  console.log('=================================================================\n');

  let dispositivoZk;

  try {
    // 1. Obtener usuarios de MySQL
    console.log('1. Consultando MySQL...');
    const [usuariosBD] = await db.query('SELECT * FROM usuarios');
    console.log(`   --> ${usuariosBD.length} usuario(s) en MySQL.\n`);

    // 2. Obtener usuarios del Biométrico K14
    console.log('2. Conectando al biométrico K14...');
    dispositivoZk = new Zkteco(BIOMETRICO_IP, BIOMETRICO_PORT, 5200, 5000);
    await dispositivoZk.createSocket();

    const responseBio = await dispositivoZk.getUsers();
    const usuariosBio = responseBio.data || [];
    console.log(`   --> ${usuariosBio.length} usuario(s) en el K14.\n`);

    // 3. Mapear ambos lados usando id_usuario (BD) y uid (K14)
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

    // A. Si está en el Biométrico pero NO en la BD -> Importar a BD detectando el Rol
    console.log('3. Verificando K14 -> MySQL...');
    for (const [idBio, bioUser] of mapBio.entries()) {
      if (!mapBD.has(idBio)) {
        const nombreTemp = String(bioUser.name || `Usuario_${idBio}`).trim().slice(0, 100);
        const pwdTemp = String(bioUser.password || '12345678');
        const ciTemp = idBio;

        // Mapeo dinámico del rol del biométrico (0 = Normal, > 0 es Admin/SuperAdmin)
        const rolBD = Number(bioUser.role) > 0 ? 1 : 0;
        const etiquetaRol = rolBD === 1 ? 'ADMIN' : 'USUARIO';

        console.log(`   ➕ Jalando a BD: [id_usuario: ${idBio}] - "${nombreTemp}" (Rol: ${etiquetaRol})`);

        await db.query(
          `INSERT INTO usuarios (id_usuario, nombre, CI, universidad, carrera, celular, estado, rol, contrasena)
           VALUES (?, ?, ?, 'UNIVALLE', 'SISTEMAS', NULL, 1, ?, ?)`,
          [idBio, nombreTemp, ciTemp, rolBD, pwdTemp]
        );
        creadosEnBD++;
      }
    }

    // B. Si está activo en MySQL pero NO en el Biométrico -> Enviar al K14
    console.log('\n4. Verificando MySQL -> K14...');
    for (const [idBD, dbUser] of mapBD.entries()) {
      if (!mapBio.has(idBD)) {
        if (Number(dbUser.estado) === 1) {
          console.log(`   🚀 Enviando a K14: [ID: ${idBD}] - "${dbUser.nombre}"`);

          const bioUid = Number(idBD);
          const bioUserId = String(idBD);
          const bioName = String(dbUser.nombre || 'Usuario').trim().slice(0, 24);

          let bioPassword = String(dbUser.contrasena || '123456').replace(/\D/g, '').slice(0, 8);
          if (!bioPassword) bioPassword = '123456';

          const bioRole = Number(dbUser.rol) === 1 ? 14 : 0; // 14 = Admin, 0 = Normal
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