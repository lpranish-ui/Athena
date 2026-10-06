import { locateContextQuote } from './questions.js';

/** Missing, duplicated or malformed blind answers never verify a question. */
export function verifiedQuestionChoices(questions, answers) {
  if (!Array.isArray(answers)) return [];
  const choices = new Map();
  const duplicates = new Set();
  for (const answer of answers) {
    const index = answer?.question_index;
    if (!Number.isInteger(index) || index < 1 || index > questions.length) continue;
    if (choices.has(index)) duplicates.add(index);
    choices.set(index, answer?.option_index);
  }
  return questions.filter((question, index) => {
    const choice = choices.get(index + 1);
    return !duplicates.has(index + 1) && Number.isInteger(choice) &&
      choice >= 0 && choice < question.options.length && choice === question.correct_index;
  });
}

/** Page numbers come from a matched source quote, never the model's page field. */
export function groundedStudyMaterial(parsed, context, kind, maxCards = 24) {
  if (kind === 'flashcards') {
    const seen = new Set();
    const cards = [];
    for (const card of Array.isArray(parsed?.cards) ? parsed.cards : []) {
      const front = typeof card?.front === 'string' ? card.front.trim() : '';
      const back = typeof card?.back === 'string' ? card.back.trim() : '';
      const quote = typeof card?.supporting_quote === 'string' ? card.supporting_quote.trim() : '';
      const located = locateContextQuote(context, quote);
      const key = front.toLowerCase().replace(/\s+/g, ' ');
      if (!front || !back || !located.found || seen.has(key)) continue;
      seen.add(key);
      cards.push({ front, back, supporting_quote: quote, source_page: located.page,
        ...(typeof card.topic === 'string' && card.topic.trim() ? { topic: card.topic.trim() } : {}) });
      if (cards.length >= maxCards) break;
    }
    return { cards };
  }
  const points = [];
  const seen = new Set();
  for (const point of Array.isArray(parsed?.points) ? parsed.points : []) {
    const heading = typeof point?.heading === 'string' ? point.heading.trim() : '';
    const detail = typeof point?.detail === 'string' ? point.detail.trim() : '';
    const quote = typeof point?.supporting_quote === 'string' ? point.supporting_quote.trim() : '';
    const located = locateContextQuote(context, quote);
    const key = heading.toLowerCase().replace(/\s+/g, ' ');
    if (!heading || !detail || !located.found || seen.has(key)) continue;
    seen.add(key);
    points.push({ heading, detail, supporting_quote: quote, page: located.page });
    if (points.length >= 12) break;
  }
  // Build the overview from verified points, rather than storing unsupported
  // free-form model prose outside the citation/verification pipeline.
  return { overview: points.slice(0, 3).map((point) => point.detail).join(' '), points };
}

export function verifiedStudyFacts(items, verdicts) {
  if (!Array.isArray(verdicts)) return [];
  const decisions = new Map();
  const duplicates = new Set();
  for (const verdict of verdicts) {
    const index = verdict?.item_index;
    if (!Number.isInteger(index) || index < 1 || index > items.length) continue;
    if (decisions.has(index)) duplicates.add(index);
    decisions.set(index, verdict.supported);
  }
  return items.filter((_, index) => !duplicates.has(index + 1) && decisions.get(index + 1) === true);
}

export const BOOK_ABSTENTION = 'I could not verify an answer in this book. Try more specific search words, or use Search to inspect the source passages.';

/** Require real cited excerpts and verified supporting quotes for book answers. */
export function groundedBookAnswer(parsed, contexts) {
  const abstain = () => ({ answer: BOOK_ABSTENTION, sources: [] });
  if (!parsed || parsed.abstain === true || typeof parsed.answer !== 'string') return abstain();
  const answer = parsed.answer.trim();
  if (!answer || !Array.isArray(parsed.evidence) || !parsed.evidence.length) return abstain();
  const sources = new Map();
  for (const item of parsed.evidence) {
    if (!Number.isInteger(item?.chapter_number) || typeof item?.supporting_quote !== 'string') return abstain();
    const context = contexts.find((chapter) => chapter.number === item.chapter_number);
    if (!context) return abstain();
    const located = locateContextQuote(context, item.supporting_quote);
    if (!located.found) return abstain();
    sources.set(context.number, { chapter_id: context.id, number: context.number, title: context.title,
      source_page: located.page, supporting_quote: item.supporting_quote.trim() });
  }
  const cited = [...answer.matchAll(/\[Ch\.\s*(\d+)\]/gi)].map((match) => Number(match[1]));
  if (!cited.length || cited.some((number) => !sources.has(number))) return abstain();
  // A quote in the answer must also exist in one of its cited source excerpts.
  // Check typographic double quotes and ordinary quotation marks, not apostrophes
  // in contractions or possessives.
  for (const match of answer.matchAll(/["“]([^"”\n]{8,})["”]/g)) {
    if (!contexts.some((context) => sources.has(context.number) && locateContextQuote(context, match[1]).found)) {
      return abstain();
    }
  }
  return { answer, sources: [...sources.values()].filter((source) => cited.includes(source.number)) };
}
