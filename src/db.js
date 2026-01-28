const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();


const pool = new Pool({
connectionString: process.env.DATABASE_URL,
max: 20,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 2000
});


pool.on('error', (err) => {
console.error('Unexpected error on idle pg client', err);
});

console.log("🔵 Using DATABASE_URL:", process.env.DATABASE_URL);

module.exports = { pool };