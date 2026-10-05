// Applies server/sql/schema.sql then server/sql/seed.sql to DATABASE_URL.
//
// Usage (from the server/ folder):
//   npm run migrate              # uses server/.env
//   DATABASE_URL=... node scripts/migrate.js

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is missing. Set it in server/.env or the environment.');
  process.exit(1);
}

const ssl = url.includes('.render.com') ? { rejectUnauthorized: false } : undefined;
const client = new pg.Client({ connectionString: url, ssl });

await client.connect();

for (const file of ['schema.sql', 'seed.sql']) {
  const sql = await readFile(path.join(here, '..', 'sql', file), 'utf8');
  await client.query(sql);
  console.log(`✓ ${file} applied`);
}

await client.end();
console.log('Database is ready.');
