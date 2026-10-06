// Word lookup for the reader — Wiktionary REST API (CORS-friendly, no key), memory-cached.
// Web + native both use fetch; failures degrade to "no definition" quietly.

export interface WordMeaning {
  partOfSpeech: string;
  definition: string;
  example?: string;
}

export interface WordDefinition {
  word: string;
  phonetic?: string;
  meanings: WordMeaning[];
}

const cache = new Map<string, WordDefinition | null>();
const MAX_MEANINGS = 4;
const LOOKUP_TIMEOUT_MS = 8000;

/** Strips punctuation and casing so tapped tokens resolve to dictionary headwords. */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z'-]/g, '')
    .replace(/^['-]+|['-]+$/g, '');
}

/** Wiktionary definitions arrive as small HTML fragments — keep their text. */
function stripHtml(input: string): string {
  return input
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

interface WiktionarySection {
  partOfSpeech?: string;
  language?: string;
  definitions?: {
    definition?: string;
    parsedExamples?: { example?: string }[];
    examples?: string[];
  }[];
}

/** Looks up an English definition; null when unknown, offline, or too short. */
export async function defineWord(raw: string): Promise<WordDefinition | null> {
  const word = normalizeWord(raw);
  if (word.length < 2) return null;
  if (cache.has(word)) return cache.get(word) ?? null;

  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS) : null;
  try {
    const response = await fetch(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
      controller ? { signal: controller.signal } : undefined,
    );
    if (!response.ok) {
      cache.set(word, null);
      return null;
    }
    const data = (await response.json()) as { en?: WiktionarySection[] };
    const meanings: WordMeaning[] = [];
    for (const section of data.en ?? []) {
      for (const definition of section.definitions ?? []) {
        const text = stripHtml(definition.definition ?? '');
        if (!text) continue;
        const exampleRaw = definition.parsedExamples?.[0]?.example ?? definition.examples?.[0];
        const example = exampleRaw ? stripHtml(exampleRaw) : '';
        meanings.push({
          partOfSpeech: section.partOfSpeech ?? '',
          definition: text,
          example: example || undefined,
        });
        if (meanings.length >= MAX_MEANINGS) break;
      }
      if (meanings.length >= MAX_MEANINGS) break;
    }
    const result: WordDefinition | null = meanings.length ? { word, meanings } : null;
    cache.set(word, result);
    return result;
  } catch {
    return null; // timeout or network hiccup — don't poison the cache
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
