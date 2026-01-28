// scripts/seed-admin.js
const { Pool } = require('pg');
const argon2 = require('argon2');
require('dotenv').config();

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ensure roles row exists
    const { rows: roleRows } = await client.query('SELECT id FROM roles WHERE id = 1');
    if (roleRows.length === 0) {
      await client.query("INSERT INTO roles (id, name) VALUES (1, 'admin') ON CONFLICT DO NOTHING");
      console.log('Inserted role admin (id=1)');
    }

    const email = 'admin@sprada.local';
    const password = 'admin';
    const fullName = 'Administrator';

    // check if user exists
    const { rows } = await client.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (rows.length > 0) {
      console.log('Admin exists:', rows[0].id, rows[0].email);
    } else {
      const hash = await argon2.hash(password);
      const { rows: ins } = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role_id, is_active)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [email, hash, fullName, 1]
      );
      console.log('Admin created:', ins[0].id);
    }
    await client.query('COMMIT');
    console.log('Done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding admin', err);
  } finally {
    client.release();
    pool.end();
  }
})();
