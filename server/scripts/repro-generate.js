// Reproduces the generate-mcqs hang and isolates the cause:
//   1. ping DeepSeek directly (does the key respond at all?)
//   2. inspect the suspicious chapter's page_map
//   3. generate on a known-good chapter (demo seed) with a 90s timeout
//   4. generate on the Oxford chapter with a 90s timeout
//
// Usage: node scripts/repro-generate.js

import { readFile } from 'node:fs/promises';

const base = 'https://athena-api-w018.onrender.com';
const OXFORD_CHAPTER = '02e08a33-e849-44a6-bddc-5a1485521a64';
const HEART_CHAPTER = 'c0000001-0000-4000-8000-000000000001';

const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);

async function call(method, path, { token, body, timeoutMs = 100000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

// ── 1. DeepSeek direct ping ──────────────────────────────────────────────────

console.log('1) DeepSeek direct ping…');
try {
  const started = Date.now();
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || 'deepseek-flash',
      messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }],
      response_format: { type: 'json_object' },
      max_tokens: 20,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  console.log(`   status=${response.status} in ${Date.now() - started}ms: ${text.slice(0, 200)}`);
} catch (error) {
  console.log(`   FAILED: ${error}`);
}

// ── sign in ──────────────────────────────────────────────────────────────────

const auth = await call('POST', '/api/auth/signin', {
  body: { email: 'demo@athena.app', password: 'athena123' },
});
if (auth.status !== 200) {
  console.error('sign-in failed', auth.status, auth.data);
  process.exit(1);
}
const token = auth.data.token;

// ── 2. Oxford chapter page_map stats ─────────────────────────────────────────

console.log('2) Oxford chapter inspection…');
const chapter = await call('GET', `/api/chapters/${OXFORD_CHAPTER}`, { token });
if (chapter.status === 200) {
  const marks = chapter.data.page_map;
  console.log(`   title="${chapter.data.title}" content=${chapter.data.content.length} chars`);
  if (Array.isArray(marks)) {
    let min = Infinity;
    let max = -Infinity;
    let bad = 0;
    for (const mark of marks) {
      if (!Number.isInteger(mark?.page) || !Number.isInteger(mark?.char_start)) {
        bad += 1;
        continue;
      }
      min = Math.min(min, mark.char_start);
      max = Math.max(max, mark.char_start);
    }
    console.log(`   page_marks=${marks.length} char_start range=[${min}, ${max}] bad=${bad}`);
    console.log(`   sample: ${JSON.stringify(marks.slice(0, 3))}`);
  } else {
    console.log('   page_map is not an array:', typeof marks);
  }
} else {
  console.log('   chapter fetch failed', chapter.status);
}

// ── 3 + 4. generate on known-good vs Oxford chapter ─────────────────────────

for (const [label, chapterId] of [
  ['known-good (Heart seed chapter)', HEART_CHAPTER],
  ['Oxford (3 Fetal medicine)', OXFORD_CHAPTER],
]) {
  console.log(`3) generate on ${label}…`);
  const started = Date.now();
  try {
    const result = await call('POST', '/api/ai/generate-mcqs', {
      token,
      timeoutMs: 200000,
      body: { chapterId, count: 5, difficulty: 'easy', questionType: 'single_best_answer' },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`   status=${result.status} in ${seconds}s: ${JSON.stringify(result.data)?.slice(0, 220)}`);
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`   REQUEST FAILED in ${seconds}s: ${error}`);
  }
}

console.log('done');
process.exitCode = 0;
