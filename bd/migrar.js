const db = require('../src/config/bd');

async function migrarRefactorGeo() {
  console.log('--- Iniciando refactorización de Geo / Teletrabajo a tabla asistencias_geo ---');
  try {
    // 1. Crear tabla asistencias_geo si no existe
    await db.query(`
      CREATE TABLE IF NOT EXISTS \`asistencias_geo\` (
        \`id_geo\` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        \`id_asistencia\` BIGINT(20) UNSIGNED NOT NULL,
        \`modalidad\` VARCHAR(30) NOT NULL DEFAULT 'PRESENCIAL',
        \`id_solicitud_teletrabajo\` BIGINT(20) UNSIGNED DEFAULT NULL,
        \`lat_entrada\` DECIMAL(10, 7) DEFAULT NULL,
        \`lng_entrada\` DECIMAL(10, 7) DEFAULT NULL,
        \`precision_entrada_m\` INT(11) DEFAULT NULL,
        \`lat_salida\` DECIMAL(10, 7) DEFAULT NULL,
        \`lng_salida\` DECIMAL(10, 7) DEFAULT NULL,
        \`precision_salida_m\` INT(11) DEFAULT NULL,
        \`creado_en\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`actualizado_en\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id_geo\`),
        UNIQUE KEY \`uk_asistencia_geo\` (\`id_asistencia\`),
        CONSTRAINT \`fk_geo_asistencia\` FOREIGN KEY (\`id_asistencia\`) REFERENCES \`asistencias\` (\`id_asistencia\` ) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabla asistencias_geo creada / verificada con éxito.');

    // 2. Verificar y quitar SOLO las columnas agregadas temporalmente de la tabla asistencias
    const [cols] = await db.query('DESCRIBE asistencias');
    const colNames = cols.map(c => c.Field);

    if (colNames.includes('modalidad')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN modalidad');
      console.log('✅ Columna modalidad eliminada de asistencias (ahora en asistencias_geo).');
    }
    if (colNames.includes('id_solicitud_teletrabajo')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN id_solicitud_teletrabajo');
      console.log('✅ Columna id_solicitud_teletrabajo eliminada de asistencias (ahora en asistencias_geo).');
    }
    if (colNames.includes('lat_entrada')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN lat_entrada');
      console.log('✅ Columna lat_entrada eliminada de asistencias.');
    }
    if (colNames.includes('lng_entrada')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN lng_entrada');
      console.log('✅ Columna lng_entrada eliminada de asistencias.');
    }
    if (colNames.includes('lat_salida')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN lat_salida');
      console.log('✅ Columna lat_salida eliminada de asistencias.');
    }
    if (colNames.includes('lng_salida')) {
      await db.query('ALTER TABLE asistencias DROP COLUMN lng_salida');
      console.log('✅ Columna lng_salida eliminada de asistencias.');
    }

    console.log('🎉 Refactorización completada con éxito. Tabla asistencias quedó intacta y limpia.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error en migración asistencias_geo:', error);
    process.exit(1);
  }
}

migrarRefactorGeo();
