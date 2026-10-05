// Diagnoses DeepSeek's intermittent EMPTY content responses on big chapters.
// Builds the exact production generation prompt (via ../src/questions.js)
// and sends it straight to the DeepSeek API with several variants, printing
// finish_reason / token usage / content + reasoning sizes for each.
//
// Usage: node scripts/diag-empty.js

import { readFile } from 'node:fs/promises';
import {
    fixedChaptersSection,
    requestSection,
    SYSTEM_PROMPT,
    withPageMarkers,
} from '../src/questions.js';

const base = 'https://athena-api-w018.onrender.com';
const OXFORD_CHAPTER = '02e08a33-e849-44a6-bddc-5a1485521a64';

const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);

async function api(method, path, { token, body, timeoutMs = 100000 } = {}) {
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

// ── sign in + fetch the big chapter ──────────────────────────────────────────

const auth = await api('POST', '/api/auth/signin', {
  body: { email: 'demo@athena.app', password: 'athena123' },
});
if (auth.status !== 200) {
  console.error('sign-in failed', auth.status, auth.data);
  process.exit(1);
}
const token = auth.data.token;

const chapter = await api('GET', `/api/chapters/${OXFORD_CHAPTER}`, { token });
if (chapter.status !== 200) {
  console.error('chapter fetch failed', chapter.status, chapter.data);
  process.exit(1);
}

// Same slice + prompt construction as generate.js for a single chapter.
const content = chapter.data.content.slice(0, 16000);
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: [
      fixedChaptersSection({
        bookTitle: 'Diag book',
        subject: 'Medicine',
        chapters: [
          { title: chapter.data.title, number: 1, textWithMarkers: withPageMarkers(content, chapter.data.page_map) },
        ],
      }),
      '',
      requestSection({
        type: 'single_best_answer',
        difficulty: 'medium',
        count: 5,
        targetExam: null,
        existingStems: [],
        multiChapter: false,
      }),
    ].join('\n'),
  },
];
console.log(`prompt: chapter=${chapter.data.content.length} chars, sliced=${content.length}, user message=${messages[1].content.length} chars\n`);

// ── variant runner ───────────────────────────────────────────────────────────

async function run(label, { jsonMode = true, thinking, maxTokens = 12000, temperature = 0.5 } = {}) {
  const started = Date.now();
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(thinking ? { thinking } : {}),
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const text = await response.text();
    if (!response.ok) {
      console.log(`[${label}] status=${response.status} ms=${Date.now() - started} body=${text.slice(0, 220)}`);
      return;
    }
    const completion = JSON.parse(text);
    const choice = completion?.choices?.[0];
    const out = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? '';
    console.log(
      `[${label}] 200 ms=${Date.now() - started} finish=${choice?.finish_reason ?? '-'} completion_tokens=${completion?.usage?.completion_tokens ?? '-'} content_chars=${out.length} reasoning_chars=${reasoning.length} head=${JSON.stringify(out.slice(0, 60))}`,
    );
  } catch (error) {
    console.log(`[${label}] FAILED after ${Date.now() - started}ms: ${error}`);
  }
}

await run('baseline jsonMode #1');
await run('baseline jsonMode #2');
await run('no-jsonMode', { jsonMode: false });
await run('thinking disabled', { thinking: { type: 'disabled' } });
await run('maxTokens 24000', { maxTokens: 24000 });
await run('baseline jsonMode #3');
console.log('done');
