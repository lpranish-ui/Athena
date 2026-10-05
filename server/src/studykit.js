// ============================================================================
// Study kit — flashcards + one-page high-yield summaries for a chapter.
// ============================================================================
// Node port of the Supabase edge function `study-kit`. Material is stored per
// (student, chapter, kind) and reused — regenerating replaces it. Page
// numbers are validated against the chapter's page map, exactly like
// generated questions.
// ============================================================================

import { chatJson, MissingKeyError } from './ai.js';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import { fixedChaptersSection, validMarks, withPageMarkers } from './questions.js';

const MIN_CARDS = 6;
const MAX_CARDS = 24;
const DEFAULT_CARDS = 12;

const SYSTEM_PROMPT = [
  'You are a senior medical educator creating concise study material from textbook chapters.',
  'Base everything ONLY on the supplied chapter text; never add outside facts.',
  'Respond with JSON only — no commentary, no markdown fences.',
].join(' ');

function parseJson(raw) {
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function validPage(value, pages) {
  const page = Number(value);
  return Number.isInteger(page) && pages.has(page) ? page : null;
}

/**
 * Generates (or regenerates) study material for one chapter.
 * Returns { kind, content }.
 */
export async function generateStudyKit({ userId, chapterId, kind, count }) {
  try {
    const cleanKind = kind === 'summary' ? 'summary' : kind === 'flashcards' ? 'flashcards' : null;
    if (!chapterId || !cleanKind) {
      throw new HttpError(400, 'chapterId and a valid kind are required.');
    }

    const cardCount = Math.min(Math.max(Math.round(count ?? DEFAULT_CARDS), MIN_CARDS), MAX_CARDS);

    const chapter = await one(
      `select c.id, c.title, c.content, c.page_map, c.first_page, c.last_page,
              b.title as book_title, b.subject as book_subject,
              (b.is_default or b.owner_id = $2) as can_access
         from chapters c
         join books b on b.id = c.book_id
        where c.id = $1`,
      [chapterId, userId],
    );
    if (!chapter || !chapter.can_access) {
      throw new HttpError(404, 'Chapter not found (or you do not have access to it).');
    }

    const context = {
      id: chapter.id,
      title: chapter.title,
      content: chapter.content.slice(0, 16000),
      pageMap: chapter.page_map ?? null,
      firstPage: chapter.first_page ?? null,
      lastPage: chapter.last_page ?? null,
    };
    const pages = new Set(validMarks(context.pageMap).map((mark) => mark.page));

    const requestText =
      cleanKind === 'flashcards'
        ? [
            `Create exactly ${cardCount} flashcards for active recall.`,
            'Rules:',
            '- "front": a short prompt, question or term (max ~25 words).',
            '- "back": a concise answer (max ~40 words).',
            '- "source_page": the printed page number of the [p. ...] marker where the fact appears (or null if unknown).',
            '- "topic": a short topic label.',
            '- Cover the whole chapter evenly; no duplicates.',
            'Return JSON: {"cards":[{"front":"...","back":"...","source_page":123,"topic":"..."}]}',
          ].join('\n')
        : [
            'Write a one-page high-yield summary of this chapter for exam revision.',
            'Rules:',
            '- "overview": 3–4 sentences capturing the chapter at a glance.',
            '- "points": 6–12 revision points, each with a short "heading" and a 1–2 sentence "detail".',
            '- "page": the printed page number of the [p. ...] marker supporting the point (or null).',
            'Return JSON: {"overview":"...","points":[{"heading":"...","detail":"...","page":123}]}',
          ].join('\n');

    const raw = await chatJson({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            fixedChaptersSection({
              bookTitle: chapter.book_title ?? 'Unknown book',
              subject: chapter.book_subject ?? 'Medicine',
              chapters: [
                {
                  title: context.title,
                  number: 1,
                  textWithMarkers: withPageMarkers(context.content, context.pageMap),
                },
              ],
            }),
            '',
            requestText,
          ].join('\n'),
        },
      ],
      // Same reasoning-headroom rule as quiz generation: the model's
      // internal thinking must fit alongside the JSON in max_tokens.
      maxTokens: 20000,
      temperature: 0.4,
      meta: { userId, purpose: `study_kit_${cleanKind}` },
    });

    const parsed = parseJson(raw);
    if (!parsed) {
      throw new HttpError(502, 'The AI response could not be parsed. Please try again.');
    }

    let content;

    if (cleanKind === 'flashcards') {
      const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
      const cards = [];
      for (const entry of rawCards) {
        const card = entry ?? {};
        const front = typeof card.front === 'string' ? card.front.trim() : '';
        const back = typeof card.back === 'string' ? card.back.trim() : '';
        if (!front || !back) continue;
        const topic = typeof card.topic === 'string' && card.topic.trim() ? card.topic.trim() : undefined;
        cards.push({ front, back, source_page: validPage(card.source_page, pages), topic });
      }
      if (cards.length < 3) {
        throw new HttpError(502, 'The AI did not produce usable flashcards. Please try again.');
      }
      content = { cards };
    } else {
      const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
      const rawPoints = Array.isArray(parsed.points) ? parsed.points : [];
      const points = [];
      for (const entry of rawPoints) {
        const point = entry ?? {};
        const heading = typeof point.heading === 'string' ? point.heading.trim() : '';
        const detail = typeof point.detail === 'string' ? point.detail.trim() : '';
        if (!heading || !detail) continue;
        points.push({ heading, detail, page: validPage(point.page, pages) });
      }
      if (!overview || points.length < 3) {
        throw new HttpError(502, 'The AI did not produce a usable summary. Please try again.');
      }
      content = { overview, points };
    }

    await query(
      `insert into study_materials (user_id, chapter_id, kind, content)
       values ($1, $2, $3, $4::jsonb)
       on conflict (user_id, chapter_id, kind) do update set content = excluded.content`,
      [userId, context.id, cleanKind, JSON.stringify(content)],
    );

    return { kind: cleanKind, content };
  } catch (error) {
    if (error instanceof MissingKeyError) throw new HttpError(500, error.message);
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, error instanceof Error && error.message ? error.message : 'Unexpected server error.');
  }
}
