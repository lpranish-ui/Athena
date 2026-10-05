// ============================================================================
// Book ingestion — turns an uploaded file (or pasted text) into a book with
// readable chapters and page maps for citations.
// ============================================================================
// Node port of the Supabase edge function `ingest-book`.
// Differences from the edge version:
//   - The uploaded file never leaves this process (no storage bucket): the
//     upload route passes the raw bytes straight in.
//   - Scanned PDFs (no text layer) are rejected with a friendly message
//     instead of being queued for the OCR worker (worker not deployed yet).
//
// Chapter detection order for PDFs: bookmarks -> printed contents page (with
// page-offset correction) -> "Chapter N" headings -> size-based parts.
// EPUB: spine documents extracted in order. TXT: read as UTF-8.
// Duplicate uploads are detected with a SHA-256 fingerprint.
// ============================================================================

import crypto from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { one, query } from './db.js';

// pdf.js uses Promise.withResolvers (ES2024) — polyfill for older Node.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const MAX_TOTAL_CHARS = 1_200_000; // safety cap per book
const MIN_TEXT_LENGTH = 100;
const MAX_CHAPTERS = 120;
const FALLBACK_CHARS_PER_PART = 9000;
const CHAPTER_BATCH_SIZE = 5;

/** Ingest error the routes can surface; `cleanup` asks the route to remove the shell book row. */
export class IngestError extends Error {
  constructor(message, { cleanup = false } = {}) {
    super(message);
    this.name = 'IngestError';
    this.cleanup = cleanup;
  }
}

// ── text cleanup ─────────────────────────────────────────────────────────────

function normalizeText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  return digest;
}

// ── PDF extraction (pdfjs-dist, page by page) ────────────────────────────────

async function resolveDestPage(doc, dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const index = await doc.getPageIndex(explicit[0]);
    return typeof index === 'number' && index >= 0 ? index + 1 : null;
  } catch {
    return null;
  }
}

function flattenOutline(items) {
  const out = [];
  const walk = (list) => {
    for (const item of list) {
      if (item && typeof item.title === 'string') out.push(item);
      if (Array.isArray(item?.items) && item.items.length > 0) walk(item.items);
    }
  };
  walk(items);
  return out;
}

async function extractPdf(bytes) {
  const doc = await getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const lines = [];
  const outline = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      let current = '';
      for (const item of content.items) {
        const str = typeof item?.str === 'string' ? item.str : '';
        current += str;
        if (item?.hasEOL) {
          const line = current.trim();
          if (line) lines.push({ text: line, page: pageNumber });
          current = '';
        } else {
          current += ' ';
        }
      }
      const lastLine = current.trim();
      if (lastLine) lines.push({ text: lastLine, page: pageNumber });

      page.cleanup();
    }

    // Bookmarks — the most reliable chapter source when the PDF has them.
    try {
      const rawOutline = await doc.getOutline();
      if (Array.isArray(rawOutline) && rawOutline.length > 0) {
        const topLevel = rawOutline.filter(
          (item) => item && typeof item.title === 'string',
        );
        const chosen = topLevel.length >= 2 ? topLevel : flattenOutline(rawOutline);

        for (const item of chosen.slice(0, 200)) {
          const page = await resolveDestPage(doc, item.dest);
          if (page !== null && typeof item.title === 'string') {
            outline.push({ title: item.title.trim().slice(0, 120), page });
          }
        }
      }
    } catch {
      // Bookmarks are optional — heading detection will handle the book.
    }
  } finally {
    await doc.destroy();
  }

  return { lines, outline };
}

// ── EPUB extraction (zip + XHTML) ────────────────────────────────────────────

function firstMatch(source, pattern) {
  const match = source.match(pattern);
  return match ? match[0] : null;
}

function allMatches(source, pattern) {
  return source.match(pattern) ?? [];
}

function attribute(tag, name) {
  const double = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  if (double) return double[1];
  const single = tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return single ? single[1] : null;
}

function resolvePath(baseDir, href) {
  const parts = `${baseDir}${href}`.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…');
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEpubText(bytes) {
  const files = unzipSync(bytes);

  const containerBytes = files['META-INF/container.xml'];
  if (!containerBytes) throw new IngestError('Not a valid EPUB (missing META-INF/container.xml).');
  const container = strFromU8(containerBytes);
  const rootfileTag = firstMatch(container, /<rootfile\b[^>]*>/i);
  const opfPath = rootfileTag ? attribute(rootfileTag, 'full-path') : null;
  if (!opfPath || !files[opfPath]) throw new IngestError('Not a valid EPUB (missing package document).');

  const opf = strFromU8(files[opfPath]);
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map();
  for (const itemTag of allMatches(opf, /<item\b[^>]*>/gi)) {
    const id = attribute(itemTag, 'id');
    const href = attribute(itemTag, 'href');
    if (id && href) manifest.set(id, href);
  }

  const spine = [];
  for (const itemref of allMatches(opf, /<itemref\b[^>]*>/gi)) {
    const idref = attribute(itemref, 'idref');
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
  }

  const sections = [];
  for (const href of spine) {
    const path = resolvePath(baseDir, href);
    const fileBytes = files[path];
    if (!fileBytes) continue;
    const text = stripHtml(strFromU8(fileBytes));
    if (text.length > 0) sections.push(text);
  }

  return sections.join('\n\n');
}

// ── document assembly ────────────────────────────────────────────────────────

/** Joins lines into content + the page -> character map used for citations. */
function buildDoc(lines) {
  let content = '';
  const pageMap = [];
  let currentPage = null;

  for (const line of lines) {
    if (content.length > 0) content += '\n';
    if (line.page !== null && line.page !== currentPage) {
      pageMap.push({ page: line.page, char_start: content.length });
      currentPage = line.page;
    }
    content += line.text;
  }

  return { content, pageMap };
}

function pagesOf(lines) {
  let first = null;
  let last = null;
  for (const line of lines) {
    if (line.page === null) continue;
    if (first === null) first = line.page;
    last = line.page;
  }
  return { first, last };
}

// ── chapter splitting ────────────────────────────────────────────────────────

const HEADING_RE =
  /^[ \t]*(?:chapter|unit|section|part)\s+([0-9]{1,3}|[ivxlcdm]{1,7})\b[\s:.\-–—]*(.{0,80})$/i;

function toChapterDraft(title, lines) {
  const { content, pageMap } = buildDoc(lines);
  const { first, last } = pagesOf(lines);
  return { title, content, pageMap, firstPage: first, lastPage: last };
}

function chunkFallback(lines) {
  const totalChars = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  const targetParts = Math.min(MAX_CHAPTERS, Math.max(1, Math.ceil(totalChars / FALLBACK_CHARS_PER_PART)));
  const chunkSize = Math.ceil(totalChars / targetParts);

  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const line of lines) {
    current.push(line);
    currentChars += line.text.length + 1;
    if (currentChars >= chunkSize) {
      chunks.push(toChapterDraft(`Part ${chunks.length + 1}`, current));
      current = [];
      currentChars = 0;
    }
  }
  if (current.length > 0) {
    chunks.push(toChapterDraft(`Part ${chunks.length + 1}`, current));
  }
  return chunks;
}

/** Builds chapter drafts from a sorted list of chapter start pages. */
function buildDraftsFromStarts(lines, starts) {
  let maxPage = 0;
  for (const line of lines) {
    if (line.page !== null && line.page > maxPage) maxPage = line.page;
  }
  if (maxPage === 0) return null;

  const drafts = [];
  for (let i = 0; i < starts.length && i < MAX_CHAPTERS; i++) {
    const from = i === 0 ? 1 : starts[i].page; // front matter joins the first chapter
    const to = i + 1 < starts.length ? starts[i + 1].page - 1 : maxPage;
    const segment = lines.filter((line) => line.page !== null && line.page >= from && line.page <= to);
    if (segment.length === 0) continue;
    drafts.push(toChapterDraft(starts[i].title || `Chapter ${i + 1}`, segment));
  }

  const usable = drafts.filter((draft) => draft.content.length >= MIN_TEXT_LENGTH);
  return usable.length >= 2 ? usable : null;
}

/** Builds chapters from the PDF's bookmarks when the outline is usable. */
function chaptersFromOutline(lines, outline) {
  const items = outline
    .filter((item) => item.page !== null && item.page >= 1)
    .sort((a, b) => a.page - b.page);
  if (items.length < 2) return null;

  // Collapse duplicate start pages (keep the first title).
  const starts = [];
  for (const item of items) {
    const last = starts[starts.length - 1];
    if (!last || last.page !== item.page) starts.push({ title: item.title, page: item.page });
  }
  if (starts.length < 2) return null;

  return buildDraftsFromStarts(lines, starts);
}

function normalizeLead(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 48)
    .trim();
}

const TOC_LINE_RE = /^(.{3,90}?)[\s.·•…]{2,}(\d{1,4})\s*$/;

/** Pulls "Title .... 123" style table-of-contents entries from the front matter. */
function tocEntriesFromLines(lines) {
  const entries = [];
  const seen = new Set();

  for (const line of lines) {
    if (line.page === null) continue;
    if (line.page > 40) break; // contents pages live near the front
    const text = line.text.trim();
    if (text.length < 4 || text.length > 100) continue;
    const match = text.match(TOC_LINE_RE);
    if (!match) continue;
    const title = match[1].replace(/[\s.·•…]+$/, '').trim();
    const printedPage = Number.parseInt(match[2], 10);
    if (!/[a-zA-Z]/.test(title) || title.length < 3) continue;
    if (!Number.isFinite(printedPage) || printedPage < 1 || printedPage > 5000) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ title, printedPage });
  }
  return entries;
}

/**
 * Builds chapters from a printed contents page: each title is found in the
 * body of the book, and the offset between printed and PDF page numbers is
 * derived from those matches (so "page 412" maps to the real PDF page).
 */
function chaptersFromToc(lines) {
  const entries = tocEntriesFromLines(lines);
  if (entries.length < 4) return null;

  const matched = [];
  for (const entry of entries) {
    const wanted = normalizeLead(entry.title);
    if (wanted.length < 6) continue;
    for (const line of lines) {
      if (line.page === null || line.page <= 40) continue; // search outside the front matter
      const candidate = normalizeLead(line.text);
      if (candidate.startsWith(wanted)) {
        matched.push({ title: entry.title, printedPage: entry.printedPage, pdfPage: line.page });
        break;
      }
    }
  }
  if (matched.length < 3) return null;

  // The offset (pdfPage − printedPage) must be consistent across matches.
  const offsetCounts = new Map();
  for (const match of matched) {
    const offset = match.pdfPage - match.printedPage;
    offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
  }
  let bestOffset = 0;
  let bestCount = 0;
  for (const [offset, count] of offsetCounts) {
    if (count > bestCount) {
      bestOffset = offset;
      bestCount = count;
    }
  }
  if (bestCount < Math.max(2, Math.floor(matched.length * 0.5))) return null;

  const starts = matched
    .map((match) => ({ title: match.title, page: match.printedPage + bestOffset }))
    .filter((start) => start.page >= 1)
    .sort((a, b) => a.page - b.page);

  const unique = [];
  for (const start of starts) {
    const last = unique[unique.length - 1];
    if (last && start.page <= last.page) continue;
    unique.push(start);
  }
  if (unique.length < 3) return null;

  return buildDraftsFromStarts(lines, unique);
}

function splitIntoChapters(lines, outline) {
  const fromOutline = chaptersFromOutline(lines, outline);
  if (fromOutline) return fromOutline;

  const fromToc = chaptersFromToc(lines);
  if (fromToc) return fromToc;

  const candidates = [];
  const seenTitles = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text.trim();
    if (!line || line.length > 90) continue;
    if (/\.{2,}\s*\d+\s*$/.test(line)) continue; // table-of-contents dot leaders
    const match = line.match(HEADING_RE);
    if (!match) continue;

    // Running headers repeat on every page — keep the first occurrence only.
    const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);

    candidates.push({ lineIndex: i, title: line.replace(/\s+/g, ' ').trim() });
  }

  if (candidates.length >= 2 && candidates.length <= 60) {
    const segments = [];
    for (let i = 0; i < candidates.length && segments.length < MAX_CHAPTERS; i++) {
      const start = candidates[i].lineIndex + 1;
      const end = i + 1 < candidates.length ? candidates[i + 1].lineIndex : lines.length;
      segments.push(toChapterDraft(candidates[i].title, lines.slice(start, end)));
    }

    // Merge near-empty segments (usually mis-detected headings) into the previous chapter.
    const merged = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (previous && segment.content.length < 300) {
        previous.content = `${previous.content}\n${segment.title}\n${segment.content}`.trim();
      } else {
        merged.push(segment);
      }
    }

    const usable = merged.filter((segment) => segment.content.length >= MIN_TEXT_LENGTH);
    if (usable.length >= 2) return usable;
  }

  return chunkFallback(lines);
}

// ── persistence ──────────────────────────────────────────────────────────────

async function insertChapters(bookId, chapters) {
  let inserted = 0;

  for (let i = 0; i < chapters.length; i += CHAPTER_BATCH_SIZE) {
    const batch = chapters.slice(i, i + CHAPTER_BATCH_SIZE);
    const placeholders = [];
    const params = [];

    batch.forEach((chapter, offset) => {
      const number = i + offset + 1;
      const base = params.length;
      params.push(
        bookId,
        number,
        chapter.title || `Chapter ${number}`,
        chapter.content,
        chapter.firstPage,
        chapter.lastPage,
        chapter.pageMap.length > 0 ? JSON.stringify(chapter.pageMap) : null,
      );
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`,
      );
    });

    await query(
      `insert into chapters (book_id, number, title, content, first_page, last_page, page_map)
       values ${placeholders.join(', ')}`,
      params,
    );
    inserted += batch.length;
  }

  return inserted;
}

async function finalizeBook(bookId, lines, outline) {
  let usable = lines;

  const totalChars = usable.reduce((sum, line) => sum + line.text.length + 1, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    // Truncate at the line level to keep page maps valid.
    let accumulated = 0;
    usable = usable.filter((line) => {
      accumulated += line.text.length + 1;
      return accumulated <= MAX_TOTAL_CHARS;
    });
  }

  const chapters = splitIntoChapters(usable, outline);
  if (chapters.length === 0) {
    throw new IngestError('No readable text was found in this book.');
  }

  const inserted = await insertChapters(bookId, chapters);
  return inserted;
}

// ── public API ───────────────────────────────────────────────────────────────

/** Builds a book from pasted text (no file involved). */
export async function ingestText({ userId, title, subject, author, text }) {
  const cleanTitle = String(title ?? '').trim();
  const cleanSubject = String(subject ?? '').trim() || 'General';
  const cleanAuthor = String(author ?? '').trim() || null;
  const cleanText = normalizeText(text ?? '');

  if (!cleanTitle) throw new IngestError('A title is required.');
  if (cleanText.length < MIN_TEXT_LENGTH) {
    throw new IngestError('That text is too short to build a book from.');
  }

  const fileHash = sha256Hex(cleanText);
  const duplicate = await one(
    'select id, title from books where owner_id = $1 and file_hash = $2 limit 1',
    [userId, fileHash],
  );
  if (duplicate) {
    throw new IngestError(
      `You have already uploaded this text as "${duplicate.title}". Delete that copy first if you want to re-upload it.`,
      { cleanup: true },
    );
  }

  const book = await one(
    `insert into books (title, subject, author, owner_id, is_default, status, file_hash)
     values ($1, $2, $3, $4, false, 'ready', $5) returning id`,
    [cleanTitle, cleanSubject, cleanAuthor, userId, fileHash],
  );
  if (!book) throw new IngestError('Could not create the book. Please try again.');

  try {
    const lines = cleanText
      .split('\n')
      .map((line) => ({ text: line.trim(), page: null }))
      .filter((line) => line.text.length > 0);

    const chapters = await finalizeBook(book.id, lines, []);
    await query('update books set status = $2, status_message = null where id = $1', [book.id, 'ready']);
    return { bookId: book.id, chapters };
  } catch (error) {
    // The book was created in this call — remove the shell row so the
    // duplicate check never trips on a failed import.
    await query('delete from books where id = $1', [book.id]).catch(() => {});
    throw error;
  }
}

/** Builds a book from an uploaded file (bytes supplied by the upload route). */
export async function ingestFile({ userId, bookId, bytes, fileType }) {
  const book = await one('select id, owner_id, file_type, title from books where id = $1', [bookId]);
  if (!book) throw new IngestError('Book not found.');
  if (book.owner_id !== userId) {
    throw new IngestError('You can only process your own uploads.');
  }

  const kind = fileType || book.file_type;
  if (!kind) throw new IngestError('This book has no file attached.');

  let lines;
  let outline = [];

  try {
    const fileHash = sha256Hex(bytes);

    // Duplicate detection: same owner + same file fingerprint.
    const duplicate = await one(
      'select id, title from books where owner_id = $1 and file_hash = $2 and id <> $3 limit 1',
      [userId, fileHash, bookId],
    );
    if (duplicate) {
      throw new IngestError(
        `You have already uploaded this file as "${duplicate.title}". Delete that copy first if you want to re-upload it.`,
        { cleanup: true },
      );
    }

    if (kind === 'pdf') {
      const extracted = await extractPdf(bytes);
      lines = extracted.lines;
      outline = extracted.outline;

      const textLength = lines.reduce((sum, line) => sum + line.text.length, 0);
      if (textLength < 500) {
        // Scanned PDF: OCR is not available on this server yet.
        throw new IngestError(
          'This PDF is a scan — it has no searchable text layer, so Athena cannot read it yet. ' +
            'Scanned-book OCR is coming later; for now please upload a text-based PDF, EPUB or TXT.',
          { cleanup: true },
        );
      }
    } else if (kind === 'epub') {
      const text = normalizeText(extractEpubText(bytes));
      lines = text
        .split('\n')
        .map((line) => ({ text: line.trim(), page: null }))
        .filter((line) => line.text.length > 0);
    } else {
      const text = normalizeText(new TextDecoder('utf-8').decode(bytes));
      lines = text
        .split('\n')
        .map((line) => ({ text: line.trim(), page: null }))
        .filter((line) => line.text.length > 0);
    }

    const chapters = await finalizeBook(bookId, lines, outline);
    await query(
      "update books set status = 'ready', status_message = null, file_hash = $2 where id = $1",
      [bookId, fileHash],
    );

    return { bookId, chapters };
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'Could not process this book.';

    // Best effort: mark the book as failed so the UI can explain what happened.
    await query(
      "update books set status = 'error', status_message = $2 where id = $1",
      [bookId, message.slice(0, 500)],
    ).catch(() => {});

    throw error instanceof IngestError ? error : new IngestError(message);
  }
}
