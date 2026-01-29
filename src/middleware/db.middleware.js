const { pool } = require('../db');

/**
 * Injects:
 *   req.db     → pooled client (pool.query)
 *   req.txRun  → transactional runner with auto commit/rollback
 */
module.exports = function dbMiddleware(req, res, next) {
  req.db = pool;

  req.txRun = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
};
