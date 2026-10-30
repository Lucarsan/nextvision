import 'dotenv/config';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL');
export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: true },
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  keepAlive: true
});
// Neon/proxies may close idle connections. Without this listener, pg re-emits
// the idle client's error on the pool and Node terminates the whole API.
// The broken client is already discarded; the next query opens a new one.
db.on('error', (error) => console.error('Conexão ociosa do banco descartada:', error.code || error.name));
export const q = (sql, values = []) => db.query(sql, values);
