/* ===================== src/tools/run_migrations.js ===================== */
// Placeholder script that runs SQL files in migrations/ in alphabetical order.
// You can drop in your SQL migration files into migrations/ and run `npm run migrate` to execute.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');


async function run() {
const dir = path.join(__dirname, '..', 'migrations');
if (!fs.existsSync(dir)) return console.log('No migrations directory found.');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
for (const f of files) {
const sql = fs.readFileSync(path.join(dir, f), 'utf8');
console.log('Running', f);
try {
await pool.query(sql);
} catch (err) {
console.error('Migration failed:', f, err);
process.exit(1);
}
}
console.log('Migrations complete.');
process.exit(0);
}


run();