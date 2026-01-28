// Middleware that creates a client per request and exposes txRun(fn) that runs a transaction
// Also helper setAppUser(userId, role) to set session variables inside the transaction
const uuid = require('uuid');


function attachTransactionMiddleware(req, res, next) {
const pool = req.db;


req.txRun = async function (fn, { userId = null, userRole = null } = {}) {
const client = await pool.connect();
try {
await client.query('BEGIN');
if (userId) {
await client.query('SET LOCAL app.user_id = $1', [userId]);
}
if (userRole) {
await client.query('SET LOCAL app.user_role = $1', [userRole]);
}
const result = await fn(client);
await client.query('COMMIT');
return result;
} catch (err) {
await client.query('ROLLBACK');
throw err;
} finally {
client.release();
}
};


next();
}


module.exports = { attachTransactionMiddleware };