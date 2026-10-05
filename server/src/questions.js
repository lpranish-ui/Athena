// ============================================================================
// Shared question-generation pipeline (used by generate-mcqs and
// replace-question routes).
// ============================================================================
// Handles: page markers, cache-friendly prompt building, JSON parsing, and
// validation — including word-for-word quote verification where the source
// page and source chapter are located from the text itself (never trusted
// from the model).
//
// Node port of supabase/functions/_shared/questions.ts.

export const QUESTION_TYPES = ['single_best_answer', 'vignette', 'true_false'];

export const TYPE_LABEL = {
  single_best_answer: 'single best answer multiple-choice (exactly 4 options)',
  vignette:
    'clinical vignette multiple-choice (a short patient scenario as the stem, exactly 4 options)',
  true_false: 'true / false (options are exactly ["True", "False"])',
};

export const SYSTEM_PROMPT = [
  'You are a senior medical school examiner writing high-yield questions for students preparing for exams.',
  'You write clear, unambiguous questions with exactly one correct option.',
  'Every question must be answerable from the supplied chapter text alone.',
  'Respond with JSON only — no commentary, no markdown fences.',
].join(' ');

// ── page markers ─────────────────────────────────────────────────────────────

export function validMarks(pageMap) {
  if (!Array.isArray(pageMap)) return [];
  return pageMap
    .filter(
      (mark) =>
        mark !== null &&
        typeof mark === 'object' &&
        Number.isInteger(mark.page) &&
        Number.isInteger(mark.char_start),
    )
    .sort((a, b) => a.char_start - b.char_start);
}

/** Inserts [p. N] markers into chapter text at the recorded page starts. */
export function withPageMarkers(content, pageMap) {
  const marks = validMarks(pageMap);
  if (marks.length === 0) return content;

  let out = '';
  let cursor = 0;
  for (const mark of marks) {
    const position = Math.max(cursor, Math.min(content.length, mark.char_start));
    out += content.slice(cursor, position);
    out += `\n[p. ${mark.page}]\n`;
    cursor = position;
  }
  out += content.slice(cursor);
  return out;
}

export function normalizeForMatch(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Finds which printed page contains the quote, using the page map. */
export function locateQuote(content, pageMap, quote) {
  const needle = normalizeForMatch(quote);
  if (needle.length < 8) return { found: false, page: null };

  const marks = validMarks(pageMap);
  if (marks.length === 0) {
    return { found: normalizeForMatch(content).includes(needle), page: null };
  }

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].char_start;
    const end = i + 1 < marks.length ? marks[i + 1].char_start : content.length;
    const slice = content.slice(Math.max(0, start), Math.max(0, end));
    if (normalizeForMatch(slice).includes(needle)) {
      return { found: true, page: marks[i].page };
    }
  }
  return { found: false, page: null };
}

// ── prompt ───────────────────────────────────────────────────────────────────

export function fixedChaptersSection(args) {
  const parts = [
    `Book: "${args.bookTitle}" — subject: ${args.subject}`,
    '',
    'The chapter text follows. Page markers like [p. 412] show the printed page number where the following text appears.',
    '',
  ];

  args.chapters.forEach((chapter, index) => {
    if (args.chapters.length > 1) {
      parts.push(`===== CHAPTER ${index + 1} of ${args.chapters.length} — "${chapter.title}" =====`);
    } else {
      parts.push(`Chapter: "${chapter.title}"`);
    }
    parts.push('<<<', chapter.textWithMarkers, '>>>', '');
  });

  return parts.join('\n');
}

export function requestSection(args) {
  const rules = [
    `Write exactly ${args.count} questions of type: ${TYPE_LABEL[args.type]}.`,
    `Difficulty: ${args.difficulty}.`,
  ];

  if (args.targetExam) {
    rules.push(`Match the style, length and clinical framing of ${args.targetExam} exam questions.`);
  }

  if (args.existingStems.length > 0) {
    rules.push(
      'Do NOT repeat or lightly reword any of these existing stems:',
      ...args.existingStems.slice(0, 25).map((stem) => `- ${stem}`),
    );
  }

  rules.push(
    'Rules:',
    '- Exactly one option is correct; never use "all of the above" or "none of the above".',
    args.type === 'true_false'
      ? '- The options must be exactly ["True", "False"] and correct_index is 0 or 1.'
      : '- Each question has exactly 4 options.',
    '- "explanation": 1–3 sentences on why the correct answer is right.',
    '- "option_explanations": one short sentence for EVERY option (why it is right or wrong), in the same order as the options.',
    '- "supporting_quote": copy 10–25 consecutive words EXACTLY (word for word) from the chapter text above that prove the answer. Never paraphrase, shorten words, or fix spelling.',
    '- "source_page": the printed page number of the [p. ...] marker just before your supporting_quote.',
    '- "topic": a short topic label (e.g. "Cardiac conduction").',
  );

  if (args.multiChapter) {
    rules.push(
      '- "chapter_index": the number of the CHAPTER section above (1-based) that the question comes from.',
    );
  }

  rules.push(
    '',
    'Return JSON in exactly this shape:',
    '{"questions":[{"question":"...","type":"...","options":["..."],"correct_index":0,"explanation":"...","option_explanations":["..."],"supporting_quote":"...","source_page":123,"topic":"..."}]}',
  );

  return rules.join('\n');
}

// ── parsing + validation ─────────────────────────────────────────────────────

export function parseQuestions(raw) {
  let text = String(raw).trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return [];
    text = text.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.questions)
      ? parsed.questions.filter((q) => typeof q === 'object' && q !== null)
      : [];
  } catch {
    return [];
  }
}

/**
 * Validates one raw question against the chapter list.
 * The supporting quote must appear word-for-word in one of the chapters; the
 * chapter and page shown on the question are located from the text itself.
 */
export function validateQuestion(raw, chapters, type) {
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((option) => typeof option === 'string')
        .map((option) => option.trim())
        .filter((option) => option.length > 0)
    : [];
  const correctIndex = Number(raw.correct_index);
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : '';
  const quote = typeof raw.supporting_quote === 'string' ? raw.supporting_quote.trim() : '';
  const topic = typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim() : undefined;

  const optionExplanations = Array.isArray(raw.option_explanations)
    ? raw.option_explanations.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    : [];

  if (!question || chapters.length === 0) return null;

  if (type === 'true_false') {
    if (options.length !== 2) return null;
  } else if (options.length !== 4) {
    return null;
  }

  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    return null;
  }

  if (options.some((option) => /all of the above|none of the above/i.test(option))) return null;

  // Locate the quote across the supplied chapters; prefer the hinted chapter.
  const hintRaw = Number(raw.chapter_index);
  const hint =
    Number.isInteger(hintRaw) && hintRaw >= 1 && hintRaw <= chapters.length ? hintRaw - 1 : -1;

  const matches = [];
  for (let index = 0; index < chapters.length; index++) {
    const located = locateQuote(chapters[index].content, chapters[index].pageMap, quote);
    if (located.found) matches.push({ index, page: located.page });
  }
  if (matches.length === 0) return null;

  const chosen =
    (hint >= 0 ? matches.find((match) => match.index === hint) : undefined) ??
    (matches.length === 1 ? matches[0] : null);
  if (!chosen) return null;

  const padded = [...optionExplanations];
  while (padded.length < options.length) padded.push('');

  return {
    question,
    type,
    options,
    correct_index: correctIndex,
    explanation,
    option_explanations: padded.slice(0, options.length),
    supporting_quote: quote,
    source_page: chosen.page,
    topic,
    chapterIndex: chosen.index,
  };
}
