const mysql = require('mysql2/promise');
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../../.env'),
});

const requiredVariables = [
  'DB_HOST',
  'DB_USER',
  'DB_DATABASE',
  'DB_PORT',
];

for (const variable of requiredVariables) {
  if (!process.env[variable]) {
    throw new Error(`Falta la variable de entorno: ${variable}`);
  }
}

const useSSL = process.env.DB_SSL === 'true';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE,
  port: Number(process.env.DB_PORT),
  timezone: '-04:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: useSSL
    ? {
        rejectUnauthorized: false,
      }
    : undefined,
});

// Auto-migración y unificación de datos históricos en asistencias
(async () => {
  try {
    const [res] = await pool.query(`
      UPDATE asistencias
      SET 
        hora_entrada = COALESCE(NULLIF(TRIM(hora_entrada), ''), TIME(fecha_hora_biometrico_entrada)),
        hora_salida = COALESCE(NULLIF(TRIM(hora_salida), ''), TIME(fecha_hora_biometrico_salida))
      WHERE (NULLIF(TRIM(hora_entrada), '') IS NULL AND fecha_hora_biometrico_entrada IS NOT NULL)
         OR (NULLIF(TRIM(hora_salida), '') IS NULL AND fecha_hora_biometrico_salida IS NOT NULL);
    `);
    if (res && res.changedRows > 0) {
      console.log(`✅ [BD Auto-Sync] Se unificaron ${res.changedRows} registros históricos de asistencias.`);
    }
  } catch (err) {
    // Si la tabla no existe aún o hay algún error menor, no bloquear
    console.error('⚠️ [BD Auto-Sync] Aviso en sincronización inicial:', err.message);
  }
})();

module.exports = pool;