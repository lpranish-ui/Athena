// "Ask this book" — a grounded tutor over one book.
//
// Retrieval is lexical, not vector-based: Postgres full-text ranking
// (ts_rank over the english stemmed tsvector) picks the chapters most likely
// to contain the answer, then the model answers STRICTLY from those
// excerpts and cites chapter numbers. This is plenty for book-sized corpora
// and needs no extra infrastructure.

import { chatJson } from './ai.js';
import { many, one } from './db.js';
import { HttpError } from './http.js';

const MAX_EXCERPT_CHARS = 6000;
const MAX_TOTAL_CHARS = 15000;

const SYSTEM_PROMPT = [
  'You are Athena, a meticulous study tutor for medical students.',
  'Answer the question using ONLY the provided book excerpts.',
  'Rules:',
  '- Cite the chapters you use inline like [Ch. 4].',
  '- Quote key phrases verbatim when they matter.',
  '- Be concise and exam-focused: short paragraphs or tight bullets.',
  '- If the excerpts do not contain the answer, say you could not find it',
  '  in this book and suggest better search words instead of guessing.',
  'Return JSON: {"answer": "...", "chapters": [4, 7]} — chapters lists only',
  'the excerpt numbers you actually used.',
].join('\n');

/** Parses the model's JSON answer defensively (fences, preamble, etc.). */
function parseAnswer(raw) {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const data = JSON.parse(raw.slice(start, end + 1));
    if (typeof data?.answer !== 'string' || !data.answer.trim()) return null;
    return data;
  } catch {
    return null;
  }
}

export async function answerQuestion({ userId, bookId, question }) {
  const q = typeof question === 'string' ? question.trim().slice(0, 400) : '';
  if (q.length < 4) throw new HttpError(400, 'Ask a question first.');

  const book = await one(
    'select id, title from books where id = $1 and (is_default or owner_id = $2)',
    [bookId, userId],
  );
  if (!book) throw new HttpError(404, 'Book not found.');

  // Rank the book's chapters by stemmed full-text relevance to the question.
  const ranked = await many(
    `select c.id, c.number, c.title,
            ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $2)) as score
       from chapters c
      where c.book_id = $1
      order by score desc
      limit 3`,
    [bookId, q],
  );
  const chosen = ranked.filter((row) => Number(row.score) > 0.001);
  if (chosen.length === 0) {
    return {
      answer:
        'I could not find anything about that in this book. Try different words, or use Search to jump straight to a passage.',
      sources: [],
    };
  }

  // Build excerpts: window around the first direct occurrence of a question
  // word so the relevant passage is actually inside the excerpt.
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  const lines = [];
  const sources = [];
  let budget = MAX_TOTAL_CHARS;

  for (const row of chosen) {
    const full = await one('select content from chapters where id = $1', [row.id]);
    const content = full?.content ?? '';
    if (!content) continue;

    let start = 0;
    const lower = content.toLowerCase();
    let best = -1;
    for (const word of words) {
      const at = lower.indexOf(word);
      if (at >= 0 && (best === -1 || at < best)) best = at;
    }
    if (best > 1400) start = best - 1200;

    const excerpt = content.slice(start, start + Math.min(MAX_EXCERPT_CHARS, budget));
    budget -= excerpt.length;
    lines.push(`[Ch. ${row.number}: ${row.title}]\n${excerpt}`);
    sources.push({ chapter_id: row.id, number: row.number, title: row.title });
    if (budget <= 1500) break;
  }

  if (lines.length === 0) {
    return {
      answer: 'I could not find anything about that in this book. Try different words.',
      sources: [],
    };
  }

  const raw = await chatJson({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [`Book: ${book.title}`, '', 'Excerpts:', ...lines, '', `Question: ${q}`].join(
          '\n',
        ),
      },
    ],
    maxTokens: 12000,
    temperature: 0.3,
    meta: { userId, purpose: 'ask_book' },
  });

  const parsed = parseAnswer(raw);
  if (!parsed) {
    throw new HttpError(502, 'The AI returned an unreadable answer. Please try again.');
  }

  const usedNumbers = new Set((Array.isArray(parsed.chapters) ? parsed.chapters : []).map(Number));
  const used = sources.filter((source) => usedNumbers.has(Number(source.number)));
  return {
    answer: parsed.answer.trim(),
    sources: used.length > 0 ? used : sources.slice(0, 1),
  };
}
