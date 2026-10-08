import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEpubText, extractPdf, ingestText, MAX_EXTRACTED_TEXT_CHARS, splitIntoChapters } from '../src/ingest.js';
import { strToU8, zipSync } from 'fflate';
import { pool } from '../src/db.js';
import { contextWithPageMarkers, excerptContext, sampleChapterContext } from '../src/context.js';
import { locateContextQuote, locateQuote, validateQuestion, withPageMarkers } from '../src/questions.js';
import { BOOK_ABSTENTION, groundedBookAnswer, groundedStudyMaterial, verifiedQuestionChoices, verifiedStudyFacts } from '../src/grounding.js';
import { relevantExcerpt, searchTerms } from '../src/retrieval.js';

const quote = 'Mitochondria produce ATP through oxidative phosphorylation to supply energy for the cell.';
const context = { id: 'chapter-a', number: 4, title: 'Cell biology', content: quote,
  pageMap: [{ page: 12, char_start: 0 }] };
const validQuestion = { question: 'Mitochondria supply cellular ATP.', options: ['True', 'False'],
  correct_index: 0, supporting_quote: quote, explanation: 'They produce ATP.' };

test('short heading chapters retain their own citations after merging', () => {
  const lines = [
    { text: 'Front matter retained in the book.', page: 1 },
    { text: 'Chapter 1 Alpha', page: 1 },
    { text: 'Long chapter content. '.repeat(25), page: 1 },
    { text: 'Chapter 2 Beta', page: 2 }, { text: quote, page: 2 },
    { text: 'Chapter 3 Gamma', page: 3 },
    { text: 'Another long chapter content. '.repeat(25), page: 3 },
  ];
  const chapters = splitIntoChapters(lines);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].firstPage, 1);
  assert.equal(chapters[0].lastPage, 2);
  assert.ok(chapters[0].content.includes('Front matter retained'));
  assert.deepEqual(locateQuote(chapters[0].content, chapters[0].pageMap, quote), { found: true, page: 2 });
});

test('chapter count limit merges the tail instead of discarding source pages', () => {
  const lines = Array.from({ length: 125 }, (_, i) => ({ text: `Unique page ${i + 1} ` + 'source material '.repeat(15), page: i + 1 }));
  const outline = lines.map((line) => ({ title: `Section ${line.page}`, page: line.page }));
  const chapters = splitIntoChapters(lines, outline);
  assert.equal(chapters.length, 120);
  assert.equal(chapters.at(-1).lastPage, 125);
  assert.ok(chapters.at(-1).content.includes('Unique page 125'));
});

test('short front sections remain readable when later chapters validate the split', () => {
  const lines = [
    { text: 'Chapter 1 Introduction', page: 1 }, { text: 'Brief source introduction.', page: 1 },
    { text: 'Chapter 2 Details', page: 2 }, { text: 'Long details. '.repeat(40), page: 2 },
    { text: 'Chapter 3 Further', page: 3 }, { text: 'Long further content. '.repeat(40), page: 3 },
  ];
  const chapters = splitIntoChapters(lines);
  assert.equal(chapters.length, 3);
  assert.ok(chapters[0].content.includes('Brief source introduction.'));
});

function mockIngestDatabase(t, { library = { user_chars: 0, total_chars: 0 } } = {}) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => { pool.query = originalQuery; pool.connect = originalConnect; });
  let book = null;
  let chapters = [];
  const events = [];
  pool.query = async (sql, params) => {
    if (sql.startsWith('select id, title from books')) return { rows: [] };
    if (sql.includes('from books') && sql.includes('total_chars')) return { rows: [library] };
    if (sql.includes('insert into books')) {
      book = { id: 'new-book', status: sql.includes("false, 'processing'") ? 'processing' : 'ready', file_hash: params[4] };
      return { rows: [{ id: book.id }] };
    }
    if (sql.startsWith('delete from books')) { book = null; return { rows: [] }; }
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  pool.connect = async () => ({
    release() { events.push('release'); },
    async query(sql, params) {
      events.push(sql.split(/\s+/)[0]);
      if (sql.includes('for update')) return { rows: [book] };
      if (sql.startsWith('select count')) return { rows: [{ count: chapters.length }] };
      if (sql.startsWith('delete from chapters')) chapters = [];
      if (sql.includes('insert into chapters')) {
        for (let i = 0; i < params.length; i += 7) chapters.push({ content: params[i + 3], pageMap: params[i + 6] });
      }
      if (sql.startsWith('update books')) { book.status = 'ready'; book.file_hash = params[1]; }
      return { rows: [] };
    },
  });
  return { get book() { return book; }, get chapters() { return chapters; }, events };
}

test('a fresh pasted book creates chapters in a transaction instead of taking the ready replay path', async (t) => {
  const fixture = mockIngestDatabase(t);
  const result = await ingestText({ userId: 'student', title: 'Biology', subject: 'General', text: quote.repeat(5) });
  assert.equal(result.chapters, 1);
  assert.equal(fixture.chapters.length, 1);
  assert.equal(fixture.book.status, 'ready');
  assert.ok(fixture.chapters[0].content.includes(quote));
  assert.ok(fixture.events.includes('begin') && fixture.events.includes('commit'));
  assert.equal(fixture.events.at(-1), 'release');
});

test('reference textbooks above six million characters retain the complete source text', async (t) => {
  const fixture = mockIngestDatabase(t);
  const text = 'First source page.\n' + ('Reference section source. '.repeat(40).trimEnd() + '\n').repeat(6000)
    + 'Final source page retained.';
  assert.ok(text.length > 6_000_000 && text.length < MAX_EXTRACTED_TEXT_CHARS);
  const result = await ingestText({ userId: 'student', title: 'Large reference book', text });
  assert.ok(result.chapters > 1 && result.chapters <= 120);
  assert.equal(fixture.book.status, 'ready');
  assert.ok(fixture.chapters.map((chapter) => chapter.content).join('\n') === text,
    'All source text, including the final page, must survive ingestion.');
});

test('a configured extracted-text limit rejects the whole book before chapter writes', async (t) => {
  const fixture = mockIngestDatabase(t);
  const previous = process.env.MAX_EXTRACTED_TEXT_CHARS;
  let configured;
  try {
    process.env.MAX_EXTRACTED_TEXT_CHARS = '200';
    configured = await import('../src/ingest.js?configured-text-limit');
  } finally {
    if (previous === undefined) delete process.env.MAX_EXTRACTED_TEXT_CHARS;
    else process.env.MAX_EXTRACTED_TEXT_CHARS = previous;
  }
  assert.equal(configured.MAX_EXTRACTED_TEXT_CHARS, 200);
  await assert.rejects(configured.ingestText({ userId: 'student', title: 'Oversized source', text: quote.repeat(5) }),
    /extracted-text limit of 200 characters/);
  assert.equal(fixture.book, null);
  assert.deepEqual(fixture.chapters, []);
  assert.deepEqual(fixture.events, []);
});

test('per-account library quotas stop a book before any chapter writes', async (t) => {
  const previous = process.env.LIBRARY_CHARS_PER_USER;
  try {
    process.env.LIBRARY_CHARS_PER_USER = '10';
    const fixture = mockIngestDatabase(t, { library: { user_chars: 900, total_chars: 0 } });
    await assert.rejects(
      ingestText({ userId: 'student', title: 'Over quota', subject: 'General', text: quote.repeat(5) }),
      /storage limit/,
    );
    assert.deepEqual(fixture.chapters, [], 'rejected books write no chapters');
    assert.equal(fixture.book, null, 'a failed import removes its shell row');
  } finally {
    if (previous === undefined) delete process.env.LIBRARY_CHARS_PER_USER;
    else process.env.LIBRARY_CHARS_PER_USER = previous;
  }
});

test('the shared global library quota stops new accounts too', async (t) => {
  const previous = process.env.LIBRARY_CHARS_TOTAL;
  try {
    process.env.LIBRARY_CHARS_TOTAL = '10';
    const fixture = mockIngestDatabase(t, { library: { user_chars: 0, total_chars: 900 } });
    await assert.rejects(
      ingestText({ userId: 'fresh-account', title: 'Shared over quota', subject: 'General', text: quote.repeat(5) }),
      /shared library storage/,
    );
    assert.deepEqual(fixture.chapters, []);
    assert.equal(fixture.book, null);
  } finally {
    if (previous === undefined) delete process.env.LIBRARY_CHARS_TOTAL;
    else process.env.LIBRARY_CHARS_TOTAL = previous;
  }
});

function textPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('the pdf.js path extracts text from a Node Buffer', async () => {
  const extracted = await extractPdf(textPdf('Mitochondria produce cellular energy.'));
  assert.ok(extracted.lines.some((line) => line.text.includes('Mitochondria produce cellular energy.')));
  assert.equal(extracted.lines[0].page, 1);
});

test('EPUB ingestion follows spine order and ignores image payloads', () => {
  const epub = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfile full-path="book/package.opf"/></container>'),
    'book/package.opf': strToU8('<package><manifest><item id="b" href="second.chapter"/><item id="a" href="first.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'),
    'book/first.xhtml': strToU8('<p>First chapter source.</p>'),
    'book/second.chapter': strToU8('<p>Second chapter source.</p>'),
    'book/image.bin': new Uint8Array(1024),
  });
  assert.equal(extractEpubText(epub), 'First chapter source.\n\nSecond chapter source.');
});

test('clipped page markers cannot fabricate later pages', () => {
  const marked = withPageMarkers('Page twelve source.', [
    { page: 12, char_start: 0 }, { page: 13, char_start: 500 },
    { page: -1, char_start: 5 }, { page: 14, char_start: -1 },
  ]);
  assert.match(marked, /\[p\. 12\]/);
  assert.doesNotMatch(marked, /\[p\. (13|14|-1)\]/);
});

test('question keys and true/false labels are strict and options keep their order', () => {
  assert.ok(validateQuestion(validQuestion, [context], 'true_false'));
  for (const key of [null, '', '0', false, 0.5, undefined, -1, 2]) {
    assert.equal(validateQuestion({ ...validQuestion, correct_index: key }, [context], 'true_false'), null);
  }
  for (const options of [['Mitochondrion', 'Nucleus'], ['False', 'True'], ['true', 'false'], ['True', 'True']]) {
    assert.equal(validateQuestion({ ...validQuestion, options }, [context], 'true_false'), null);
  }
  assert.equal(validateQuestion({ ...validQuestion, options: ['A', null, 'B', 'C', 'D'] }, [context], 'single_best_answer'), null);
});

test('quote matching preserves medically meaningful signs and supports page breaks', () => {
  assert.equal(locateQuote('A dose of +10 mg is prescribed daily.', null, 'A dose of -10 mg').found, false);
  const boundary = quote.indexOf('oxidative');
  assert.deepEqual(locateQuote(quote, [{ page: 12, char_start: 0 }, { page: 13, char_start: boundary }], quote), { found: true, page: 12 });
});

test('bounded chapter sampling spans the chapter, rotates interiors and preserves source pages', () => {
  const pages = Array.from({ length: 20 }, (_, index) => (`Page ${index + 1} disease marker and specialized medical fact. `).repeat(80));
  let offset = 0;
  const page_map = pages.map((page, index) => { const mark = { page: index + 1, char_start: offset }; offset += page.length; return mark; });
  const row = { id: 'big', title: 'Large chapter', content: pages.join(''), page_map };
  const sampled = sampleChapterContext(row, 6000);
  assert.ok(sampled.content.length <= 6000);
  assert.equal(sampled.segments.length, 4);
  assert.equal(sampled.firstPage, 1);
  assert.equal(sampled.lastPage, 20);
  assert.notEqual(sampled.segments[1].sourceStart, sampleChapterContext(row, 6000, { phase: 1 }).segments[1].sourceStart);
  for (const segment of sampled.segments) {
    const text = segment.content.slice(100, 220);
    assert.equal(locateContextQuote(sampled, text).found, true);
    assert.ok(segment.pageMap.every((mark) => mark.char_start >= 0 && mark.char_start < segment.content.length));
  }
  const cropped = excerptContext(row, page_map[5].char_start + 100, 400);
  assert.deepEqual(cropped.pageMap, [{ page: 6, char_start: 0 }]);
  assert.match(contextWithPageMarkers(sampled), /\[p\. 20\]/);
  const artificial = sampled.content.slice(sampled.segments[0].content.length - 20, sampled.segments[0].content.length + 70);
  assert.equal(locateContextQuote(sampled, artificial).found, false);
});

test('missing, duplicate and invalid blind answers do not verify questions', () => {
  const questions = [{ options: ['a', 'b'], correct_index: 0 }, { options: ['c', 'd'], correct_index: 1 }];
  assert.deepEqual(verifiedQuestionChoices(questions, null), []);
  assert.deepEqual(verifiedQuestionChoices(questions, [{ question_index: 1, option_index: 0 }]), [questions[0]]);
  assert.deepEqual(verifiedQuestionChoices(questions, [
    { question_index: 1, option_index: 0 }, { question_index: 1, option_index: 0 },
    { question_index: 2, option_index: 9 },
  ]), []);
  assert.deepEqual(verifiedQuestionChoices(questions, [{ question_index: 2, option_index: '1' }]), []);
});

test('kits derive citations from matched source quotes and reject unsupported/duplicate cards', () => {
  const card = { front: 'What produces ATP?', back: 'Mitochondria.', supporting_quote: quote, source_page: 999 };
  const material = groundedStudyMaterial({ cards: [card, card, { ...card, front: 'Another', supporting_quote: 'Invented medical information.' }] }, context, 'flashcards');
  assert.equal(material.cards.length, 1);
  assert.equal(material.cards[0].source_page, 12);
  const summary = groundedStudyMaterial({ overview: 'Unsupported invented overview.', points: [{ heading: 'ATP', detail: 'Mitochondria supply energy.', supporting_quote: quote, page: 999 }] }, context, 'summary');
  assert.equal(summary.points[0].page, 12);
  assert.equal(summary.overview, 'Mitochondria supply energy.');
  assert.deepEqual(verifiedStudyFacts(material.cards, []), []);
  assert.deepEqual(verifiedStudyFacts(material.cards, [{ item_index: 1, supported: 'true' }]), []);
  assert.deepEqual(verifiedStudyFacts(material.cards, [{ item_index: 1, supported: true }]), material.cards);
});

test('book answers abstain on missing evidence, invented chapters and fabricated quotations', () => {
  const response = { answer: 'Mitochondria produce ATP. [Ch. 4]', evidence: [{ chapter_number: 4, supporting_quote: quote }] };
  const grounded = groundedBookAnswer(response, [context]);
  assert.equal(grounded.sources[0].source_page, 12);
  assert.equal(grounded.sources[0].chapter_id, 'chapter-a');
  for (const bad of [
    { answer: 'An unsupported answer. [Ch. 4]', evidence: [] },
    { ...response, answer: 'Mitochondria produce ATP. [Ch. 999]' },
    { ...response, answer: 'The book says "Mitochondria make gold". [Ch. 4]' },
    { ...response, evidence: [{ chapter_number: 4, supporting_quote: 'This is a fabricated quotation.' }] },
  ]) assert.deepEqual(groundedBookAnswer(bad, [context]), { answer: BOOK_ABSTENTION, sources: [] });
});

test('Ask retrieves the specific passage instead of the first generic question word', () => {
  const content = 'Treatment is described here. '.repeat(300) + '\n' +
    'Pericarditis treatment includes rest and anti-inflammatory therapy. '.repeat(10);
  const terms = searchTerms('Please explain the treatment of pericarditis and ATP');
  assert.deepEqual(terms, ['treatment', 'pericarditis', 'atp']);
  const excerpt = relevantExcerpt({ id: 'c', content }, terms, 1000);
  assert.ok(excerpt.content.includes('Pericarditis'));
  assert.ok(excerpt.content.length <= 1000);
  assert.equal(relevantExcerpt({ content }, ['kidney'], 1000), null);
});
