// Diagnoses connectivity to the Render Postgres instance, step by step:
// DNS -> TCP -> TLS handshake -> pg connect (with and without SSL).
//
// Usage: $env:PROBE_DATABASE_URL='postgresql://...'; node scripts/probe-db.js

import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';

const url = process.env.PROBE_DATABASE_URL;
if (!url) {
  console.error('PROBE_DATABASE_URL is required.');
  process.exit(1);
}

const parsed = new URL(url);
const host = parsed.hostname;
const port = Number(parsed.port || 5432);

console.log(`probing ${host}:${port} (user ${parsed.username}, db ${parsed.pathname.slice(1)})`);

try {
  const addrs = await dns.lookup(host, { all: true });
  console.log('DNS:', addrs.map((a) => `${a.address} (v${a.family})`).join(', '));
} catch (error) {
  console.error('DNS failed:', error.message);
}

await new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 8000 });
  socket.on('connect', () => {
    console.log('TCP: connected');
    socket.destroy();
    resolve();
  });
  socket.on('timeout', () => {
    console.error('TCP: timed out after 8s');
    socket.destroy();
    resolve();
  });
  socket.on('error', (error) => {
    console.error('TCP error:', error.message);
    resolve();
  });
});

await new Promise((resolve) => {
  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 });
  socket.on('secureConnect', () => {
    console.log('TLS: handshake ok (authorized =', socket.authorized + ')');
    socket.end();
    resolve();
  });
  socket.on('timeout', () => {
    console.error('TLS: timed out after 8s');
    socket.destroy();
    resolve();
  });
  socket.on('error', (error) => {
    console.error('TLS error:', error.message);
    resolve();
  });
});

for (const useSsl of [true, false]) {
  const client = new pg.Client({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    const result = await client.query('select current_user as u, version() as v');
    console.log(`PG (ssl=${useSsl}): connected as ${result.rows[0].u}`);
    await client.end();
    break;
  } catch (error) {
    console.error(`PG (ssl=${useSsl}) failed: [${error.code ?? '?'}] ${error.message}`);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
