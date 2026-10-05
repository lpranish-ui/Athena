// Postgres pool + tiny query helpers used across the API.

import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL ?? '';

if (!connectionString) {
  console.error(
    'DATABASE_URL is missing. Set it in server/.env (local dev) or the service environment on Render.',
  );
}

/** Render's external hostnames need SSL; internal connections (same region) do not. */
function sslFor(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.render.com') ? { rejectUnauthorized: false } : undefined;
  } catch {
    return undefined;
  }
}

export const pool = new Pool({
  connectionString,
  ssl: sslFor(connectionString),
  max: 5,
});

pool.on('error', (error) => {
  console.error('Unexpected database pool error:', error.message);
});

/** Runs a query and returns the full result. */
export function query(text, params) {
  return pool.query(text, params);
}

/** Runs a query and returns the first row (or null). */
export async function one(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] ?? null;
}

/** Runs a query and returns all rows. */
export async function many(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

/** Runs a set of statements inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
