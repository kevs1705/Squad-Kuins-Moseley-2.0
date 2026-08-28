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

module.exports = pool;