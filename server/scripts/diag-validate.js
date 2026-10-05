// Compares thinking-ON vs thinking-OFF output quality: runs the EXACT
// production prompt for generation, then the production parse+validate
// pipeline locally, and reports per-question failure reasons.
//
// Usage: node scripts/diag-validate.js

import { readFile } from 'node:fs/promises';
import {
  fixedChaptersSection,
  normalizeForMatch,
  parseQuestions,
  requestSection,
  SYSTEM_PROMPT,
  validateQuestion,
  withPageMarkers,
} from '../src/questions.js';

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

const auth = await api('POST', '/api/auth/signin', {
  body: { email: 'demo@athena.app', password: 'athena123' },
});
if (auth.status !== 200) {
  console.error('sign-in failed', auth.status, auth.data);
  process.exit(1);
}
const token = auth.data.token;

async function examine(label, chapterId, thinkingDisabled) {
  const chapter = await api('GET', `/api/chapters/${chapterId}`, { token });
  if (chapter.status !== 200) {
    console.log(`[${label}] chapter fetch failed ${chapter.status}`);
    return;
  }
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
        response_format: { type: 'json_object' },
        ...(thinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
        temperature: 0.5,
        max_tokens: 12000,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (!response.ok) {
      console.log(`[${label}] status=${response.status} ms=${Date.now() - started} body=${text.slice(0, 200)}`);
      return;
    }
    const completion = JSON.parse(text);
    const out = completion?.choices?.[0]?.message?.content ?? '';
    const candidates = parseQuestions(out);
    const contexts = [{ content, pageMap: chapter.data.page_map }];
    const valid = candidates.map((c) => validateQuestion(c, contexts, 'single_best_answer'));
    const validCount = valid.filter(Boolean).length;

    console.log(
      `[${label}] ${Date.now() - started}ms content=${out.length} parsed=${candidates.length} valid=${validCount}`,
    );

    const normalizedContent = normalizeForMatch(content);
    candidates.forEach((candidate, index) => {
      if (valid[index]) return;
      const opts = Array.isArray(candidate.options) ? candidate.options.length : -1;
      const quote = typeof candidate.supporting_quote === 'string' ? candidate.supporting_quote : '';
      const quoteFound = quote.length >= 8 ? normalizedContent.includes(normalizeForMatch(quote)) : false;
      console.log(
        `  #${index + 1} FAIL opts=${opts} correct_index=${JSON.stringify(candidate.correct_index)} quote_chars=${quote.length} quote_found=${quoteFound}`,
      );
      if (quote.length > 0 && quote.length <= 200) {
        console.log(`     quote: ${JSON.stringify(quote.slice(0, 140))}`);
      }
    });
  } catch (error) {
    console.log(`[${label}] FAILED after ${Date.now() - started}ms: ${error}`);
  }
}

await examine('Oxford thinking OFF', OXFORD_CHAPTER, true);
await examine('Oxford thinking ON', OXFORD_CHAPTER, false);
await examine('Heart thinking OFF', HEART_CHAPTER, true);
await examine('Heart thinking ON', HEART_CHAPTER, false);
console.log('done');
