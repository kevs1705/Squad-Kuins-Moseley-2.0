const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Cargar .env manualmente si existe en la raíz del proyecto
try {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf-8');
    envConfig.split(/\r?\n/).forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        const match = trimmedLine.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1].trim();
          let value = (match[2] || '').trim();
          // Quitar comillas si existen
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
          }
          process.env[key] = value;
        }
      }
    });
  }
} catch (e) {
  console.error("Error al cargar .env:", e);
}

const host = process.env.db_host || process.env.DB_HOST || process.env.host || process.env.HOST || '127.0.0.1';
const user = process.env.db_user || process.env.DB_USER || process.env.user || process.env.USER || 'root';
const password = process.env.db_password !== undefined ? process.env.db_password : (process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : (process.env.password !== undefined ? process.env.password : (process.env.PASSWORD !== undefined ? process.env.PASSWORD : '')));
const database = process.env.db_database || process.env.DB_DATABASE || process.env.database || process.env.DATABASE || 'ciapeco1_monseley';
const port = Number(process.env.db_port || process.env.DB_PORT || process.env.port || process.env.PORT) || 3306;

// Enable SSL only for remote database connections (when host environment variable is set and not pointing to localhost)
const useSSL = (process.env.db_host || process.env.DB_HOST || process.env.host || process.env.HOST) && host !== '127.0.0.1' && host !== 'localhost';

const pool = mysql.createPool({
  host: host,
  user: user,
  password: password,
  database: database,
  port: port,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: useSSL ? {
    rejectUnauthorized: false
  } : false
});

module.exports = pool;