// Uploads a file of ANY size through the chunked upload pipeline and waits
// for the server to process it.
//
//   node scripts/test-big-upload.js <filePath> <pdf|txt|epub>
//
// Uses the demo account. Prints progress, then the resulting book + chapters.

import { open, stat } from 'node:fs/promises';

const base = 'https://athena-api-w018.onrender.com';
const [, , filePath, fileKind] = process.argv;
if (!filePath || !fileKind) {
  console.error('usage: node scripts/test-big-upload.js <filePath> <pdf|txt|epub>');
  process.exit(1);
}

const CHUNK = 8 * 1024 * 1024;

async function call(method, path, { token, body, raw, timeoutMs = 120000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(raw ? { body: raw } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const auth = await call('POST', '/api/auth/signin', {
  body: { email: 'demo@athena.app', password: 'athena123' },
});
if (auth.status !== 200) {
  console.error('sign-in failed', auth.status, auth.data);
  process.exit(1);
}
const token = auth.data.token;

const fileName = filePath.replace(/\\/g, '/').split('/').pop();
const info = await stat(filePath);
console.log(`file: ${fileName} (${(info.size / 1024 / 1024).toFixed(1)} MB, ${fileKind})`);

const started = await call('POST', '/api/uploads', {
  token,
  body: { fileName, title: `Big upload test ${new Date().toISOString().slice(11, 19)}` },
});
if (started.status !== 201) {
  console.error('start failed', started.status, started.data);
  process.exit(1);
}
const bookId = started.data.bookId;
console.log(`book created: ${bookId}`);

const handle = await open(filePath, 'r');
try {
  const buffer = Buffer.alloc(CHUNK);
  let sent = 0;
  const began = Date.now();
  while (sent < info.size) {
    const length = Math.min(CHUNK, info.size - sent);
    await handle.read(buffer, 0, length, sent);
    const slice = buffer.subarray(0, length);
    const target = Math.min(sent + length, info.size);
    const up = await call('PUT', `/api/uploads/${bookId}/chunk`, { token, raw: slice });
    if (up.status !== 200) {
      console.error('chunk failed', up.status, up.data);
      process.exit(1);
    }
    sent = target;
    const pct = Math.round((sent / info.size) * 100);
    console.log(`  uploaded ${pct}% (${(sent / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`upload done in ${((Date.now() - began) / 1000).toFixed(1)}s`);
} finally {
  await handle.close();
}

const finish = await call('POST', `/api/uploads/${bookId}/finish`, { token, body: { size: info.size } });
console.log('finish:', finish.status, JSON.stringify(finish.data));

const pollBegan = Date.now();
for (;;) {
  const book = await call('GET', `/api/books/${bookId}`, { token });
  const status = book.data?.status;
  const note = book.data?.status_message ?? '';
  console.log(`  status=${status} ${note ? `(${note})` : ''}`);
  if (status === 'ready') {
    const chapters = await call('GET', `/api/books/${bookId}/chapters`, { token });
    console.log(`READY in ${((Date.now() - pollBegan) / 1000).toFixed(1)}s — ${chapters.data.length} chapters`);
    console.log(`first chapters: ${chapters.data.slice(0, 5).map((c) => `${c.number}. ${c.title}`).join(' | ')}`);
    console.log('TEST OK');
    break;
  }
  if (status === 'error') {
    console.log(`FAILED: ${note}`);
    break;
  }
  if (Date.now() - pollBegan > 15 * 60 * 1000) {
    console.log('timed out waiting');
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
