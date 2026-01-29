const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('connect', () => {
  console.log('🟢 Connected to Supabase PostgreSQL');
});

pool.on('error', (err) => {
  console.error('🔴 Unexpected PG error', err);
  process.exit(1);
});

module.exports = { pool };
