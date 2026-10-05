// ============================================================================
// Athena Edge Function: study-kit
// ============================================================================
// Creates study material for one chapter:
//   - kind: 'flashcards' — a deck of question/answer cards (Anki-exportable)
//   - kind: 'summary'    — a one-page high-yield summary with page references
//
// Material is stored per (student, chapter, kind) and reused — regenerating
// replaces it. Page numbers are validated against the chapter's page map.
//
// Request  (POST, authenticated):
//   { chapterId: string, kind: 'flashcards' | 'summary', count? (flashcards) }
// Response: { kind, content }  or  { error }
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatJson, MissingKeyError } from '../_shared/ai.ts';
import { corsHeaders, errorMessage, jsonResponse } from '../_shared/cors.ts';
import {
    fixedChaptersSection,
    validMarks,
    withPageMarkers,
    type ChapterContext,
} from '../_shared/questions.ts';

const MIN_CARDS = 6;
const MAX_CARDS = 24;
const DEFAULT_CARDS = 12;

const SYSTEM_PROMPT = [
  'You are a senior medical educator creating concise study material from textbook chapters.',
  'Base everything ONLY on the supplied chapter text; never add outside facts.',
  'Respond with JSON only — no commentary, no markdown fences.',
].join(' ');

interface RequestBody {
  chapterId?: string;
  kind?: string;
  count?: number;
}

interface Flashcard {
  front: string;
  back: string;
  source_page: number | null;
  topic?: string;
}

interface SummaryPoint {
  heading: string;
  detail: string;
  page: number | null;
}

function parseJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
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
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validPage(value: unknown, pages: Set<number>): number | null {
  const page = Number(value);
  return Number.isInteger(page) && pages.has(page) ? page : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData?.user;
    if (userError || !user) {
      return jsonResponse({ error: 'You must be signed in.' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const kind = body.kind === 'summary' ? 'summary' : body.kind === 'flashcards' ? 'flashcards' : null;
    if (!body.chapterId || !kind) {
      return jsonResponse({ error: 'chapterId and a valid kind are required.' }, 400);
    }

    const cardCount = Math.min(
      Math.max(Math.round(body.count ?? DEFAULT_CARDS), MIN_CARDS),
      MAX_CARDS,
    );

    const { data: chapter, error: chapterError } = await supabase
      .from('chapters')
      .select('id, title, content, page_map, first_page, last_page, book:books (title, subject)')
      .eq('id', body.chapterId)
      .single();

    if (chapterError || !chapter) {
      return jsonResponse({ error: 'Chapter not found (or you do not have access to it).' }, 404);
    }

    const book = (chapter as { book?: { title: string; subject: string } | null }).book ?? null;
    const context: ChapterContext = {
      id: chapter.id as string,
      title: chapter.title as string,
      content: (chapter.content as string).slice(0, 16000),
      pageMap: (chapter as { page_map?: unknown }).page_map ?? null,
      firstPage: (chapter as { first_page?: number | null }).first_page ?? null,
      lastPage: (chapter as { last_page?: number | null }).last_page ?? null,
    };
    const pages = new Set(validMarks(context.pageMap).map((mark) => mark.page));

    const requestText =
      kind === 'flashcards'
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
              bookTitle: book?.title ?? 'Unknown book',
              subject: book?.subject ?? 'Medicine',
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
      maxTokens: 6000,
      temperature: 0.4,
      meta: { client: supabase, userId: user.id, purpose: `study_kit_${kind}` },
    });

    const parsed = parseJson(raw);
    if (!parsed) {
      return jsonResponse({ error: 'The AI response could not be parsed. Please try again.' }, 502);
    }

    let content: Record<string, unknown>;

    if (kind === 'flashcards') {
      const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
      const cards: Flashcard[] = [];
      for (const entry of rawCards) {
        const card = entry as Record<string, unknown>;
        const front = typeof card.front === 'string' ? card.front.trim() : '';
        const back = typeof card.back === 'string' ? card.back.trim() : '';
        if (!front || !back) continue;
        const topic =
          typeof card.topic === 'string' && card.topic.trim() ? card.topic.trim() : undefined;
        cards.push({
          front,
          back,
          source_page: validPage(card.source_page, pages),
          topic,
        });
      }
      if (cards.length < 3) {
        return jsonResponse(
          { error: 'The AI did not produce usable flashcards. Please try again.' },
          502,
        );
      }
      content = { cards };
    } else {
      const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
      const rawPoints = Array.isArray(parsed.points) ? parsed.points : [];
      const points: SummaryPoint[] = [];
      for (const entry of rawPoints) {
        const point = entry as Record<string, unknown>;
        const heading = typeof point.heading === 'string' ? point.heading.trim() : '';
        const detail = typeof point.detail === 'string' ? point.detail.trim() : '';
        if (!heading || !detail) continue;
        points.push({ heading, detail, page: validPage(point.page, pages) });
      }
      if (!overview || points.length < 3) {
        return jsonResponse(
          { error: 'The AI did not produce a usable summary. Please try again.' },
          502,
        );
      }
      content = { overview, points };
    }

    const { error: upsertError } = await supabase.from('study_materials').upsert(
      {
        user_id: user.id,
        chapter_id: context.id,
        kind,
        content,
      },
      { onConflict: 'user_id,chapter_id,kind' },
    );

    if (upsertError) {
      return jsonResponse({ error: `Could not save the material: ${upsertError.message}` }, 500);
    }

    return jsonResponse({ kind, content });
  } catch (err) {
    if (err instanceof MissingKeyError) {
      return jsonResponse({ error: err.message }, 500);
    }
    return jsonResponse({ error: errorMessage(err, 'Unexpected server error.') }, 500);
  }
});
