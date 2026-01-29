<<<<<<< Updated upstream
'use strict';
=======

const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();
>>>>>>> Stashed changes

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // ✅ REQUIRED for Supabase on Render
  ssl: {
    rejectUnauthorized: false
  },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Log successful connection
pool.on('connect', () => {
  console.log('🟢 Connected to Supabase PostgreSQL');
});

// Catch SSL / network errors
pool.on('error', (err) => {
  console.error('🔴 PG Pool Error:', err.message);
  process.exit(1);
});

<<<<<<< Updated upstream
=======
console.log("🔵 Using DATABASE_URL:", process.env.DATABASE_URL);

>>>>>>> Stashed changes
module.exports = { pool };
