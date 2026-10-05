// Connects exactly like the server does (src/db.js pool) and runs a query.
// Usage: node --env-file=.env scripts/probe-pool.js

import { pool, query } from '../src/db.js';

try {
  const result = await query('select current_user as u, current_database() as db, now() as now');
  console.log('pool query ok:', result.rows[0]);
} catch (error) {
  console.error('pool query failed:', error.code ?? '', error.message);
} finally {
  await pool.end().catch(() => {});
}
