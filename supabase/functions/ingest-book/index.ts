// ============================================================================
// Athena Edge Function: ingest-book
// ============================================================================
// Turns an uploaded file (or pasted text) into a book with readable chapters.
//
// - PDF chapter detection order: bookmarks -> printed contents page (with
//   page-offset correction) -> "Chapter N" headings -> size-based parts.
//   Each chapter records its printed page range and a page -> character map,
//   so generated questions can cite their source page.
// - Scanned PDFs (no text layer) are queued for the Python OCR worker.
// - EPUB: spine documents are extracted in order (fflate zip reader).
// - TXT: read as UTF-8.
// - Duplicate uploads are detected with a SHA-256 fingerprint of the file.
//
// Request  (POST, authenticated):
//   { mode: 'file', bookId: string }
//   { mode: 'text', title, subject, author?, text }
// Response: { bookId, chapters }  or  { error }
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { strFromU8, unzipSync } from 'npm:fflate@0.8.2';
import { getDocument } from 'npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs';
import { corsHeaders, errorMessage, jsonResponse } from '../_shared/cors.ts';

const MAX_TOTAL_CHARS = 1_200_000; // safety cap per book
const MIN_TEXT_LENGTH = 100;
const MAX_CHAPTERS = 120;
const FALLBACK_CHARS_PER_PART = 9000;

type FileKind = 'pdf' | 'epub' | 'txt';

interface RequestBody {
  mode?: 'file' | 'text';
  bookId?: string;
  title?: string;
  subject?: string;
  author?: string;
  text?: string;
}

interface DocLine {
  text: string;
  page: number | null;
}

interface PageMark {
  page: number;
  char_start: number;
}

interface ChapterDraft {
  title: string;
  content: string;
  pageMap: PageMark[];
  firstPage: number | null;
  lastPage: number | null;
}

// ── text cleanup ─────────────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return crypto.subtle.digest('SHA-256', bytes).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  );
}

// ── PDF extraction (pdfjs-dist, page by page) ────────────────────────────────

interface OutlineItem {
  title: string;
  page: number | null;
}

interface PdfExtraction {
  lines: DocLine[];
  outline: OutlineItem[];
}

/** Resolves a pdf.js outline destination to a 1-based page number. */
async function resolveDestPage(doc: unknown, dest: unknown): Promise<number | null> {
  try {
    const pdfDoc = doc as {
      getDestination: (name: string) => Promise<unknown>;
      getPageIndex: (ref: unknown) => Promise<number>;
    };
    let explicit: unknown = dest;
    if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const index = await pdfDoc.getPageIndex(explicit[0]);
    return typeof index === 'number' && index >= 0 ? index + 1 : null;
  } catch {
    return null;
  }
}

function flattenOutline(items: unknown[]): { title?: unknown; dest?: unknown; items?: unknown[] }[] {
  const out: { title?: unknown; dest?: unknown; items?: unknown[] }[] = [];
  const walk = (list: unknown[]) => {
    for (const item of list as { title?: unknown; dest?: unknown; items?: unknown[] }[]) {
      if (item && typeof item.title === 'string') out.push(item);
      if (Array.isArray(item?.items) && item.items.length > 0) walk(item.items);
    }
  };
  walk(items);
  return out;
}

async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  const doc = await getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const lines: DocLine[] = [];
  const outline: OutlineItem[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      let current = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
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
      const rawOutline = await (doc as { getOutline: () => Promise<unknown> }).getOutline();
      if (Array.isArray(rawOutline) && rawOutline.length > 0) {
        const topLevel = rawOutline.filter(
          (item) => item && typeof (item as { title?: unknown }).title === 'string',
        ) as { title?: unknown; dest?: unknown }[];
        const chosen: { title?: unknown; dest?: unknown }[] =
          topLevel.length >= 2 ? topLevel : flattenOutline(rawOutline);

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

function firstMatch(source: string, pattern: RegExp): string | null {
  const match = source.match(pattern);
  return match ? match[0] : null;
}

function allMatches(source: string, pattern: RegExp): string[] {
  return source.match(pattern) ?? [];
}

function attribute(tag: string, name: string): string | null {
  const double = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  if (double) return double[1];
  const single = tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return single ? single[1] : null;
}

function resolvePath(baseDir: string, href: string): string {
  const parts = `${baseDir}${href}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function decodeEntities(text: string): string {
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

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
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

function extractEpubText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);

  const containerBytes = files['META-INF/container.xml'];
  if (!containerBytes) throw new Error('Not a valid EPUB (missing META-INF/container.xml).');
  const container = strFromU8(containerBytes);
  const rootfileTag = firstMatch(container, /<rootfile\b[^>]*>/i);
  const opfPath = rootfileTag ? attribute(rootfileTag, 'full-path') : null;
  if (!opfPath || !files[opfPath]) throw new Error('Not a valid EPUB (missing package document).');

  const opf = strFromU8(files[opfPath]);
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, string>();
  for (const itemTag of allMatches(opf, /<item\b[^>]*>/gi)) {
    const id = attribute(itemTag, 'id');
    const href = attribute(itemTag, 'href');
    if (id && href) manifest.set(id, href);
  }

  const spine: string[] = [];
  for (const itemref of allMatches(opf, /<itemref\b[^>]*>/gi)) {
    const idref = attribute(itemref, 'idref');
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref)!);
  }

  const sections: string[] = [];
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
function buildDoc(lines: DocLine[]): { content: string; pageMap: PageMark[] } {
  let content = '';
  const pageMap: PageMark[] = [];
  let currentPage: number | null = null;

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

function pagesOf(lines: DocLine[]): { first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
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

function toChapterDraft(title: string, lines: DocLine[]): ChapterDraft {
  const { content, pageMap } = buildDoc(lines);
  const { first, last } = pagesOf(lines);
  return { title, content, pageMap, firstPage: first, lastPage: last };
}

function chunkFallback(lines: DocLine[]): ChapterDraft[] {
  const totalChars = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  const targetParts = Math.min(MAX_CHAPTERS, Math.max(1, Math.ceil(totalChars / FALLBACK_CHARS_PER_PART)));
  const chunkSize = Math.ceil(totalChars / targetParts);

  const chunks: ChapterDraft[] = [];
  let current: DocLine[] = [];
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
function buildDraftsFromStarts(
  lines: DocLine[],
  starts: { title: string; page: number }[],
): ChapterDraft[] | null {
  let maxPage = 0;
  for (const line of lines) {
    if (line.page !== null && line.page > maxPage) maxPage = line.page;
  }
  if (maxPage === 0) return null;

  const drafts: ChapterDraft[] = [];
  for (let i = 0; i < starts.length && i < MAX_CHAPTERS; i++) {
    const from = i === 0 ? 1 : starts[i].page; // front matter joins the first chapter
    const to = i + 1 < starts.length ? starts[i + 1].page - 1 : maxPage;
    const segment = lines.filter(
      (line) => line.page !== null && line.page >= from && line.page <= to,
    );
    if (segment.length === 0) continue;
    drafts.push(toChapterDraft(starts[i].title || `Chapter ${i + 1}`, segment));
  }

  const usable = drafts.filter((draft) => draft.content.length >= MIN_TEXT_LENGTH);
  return usable.length >= 2 ? usable : null;
}

/** Builds chapters from the PDF's bookmarks when the outline is usable. */
function chaptersFromOutline(lines: DocLine[], outline: OutlineItem[]): ChapterDraft[] | null {
  const items = outline
    .filter((item) => item.page !== null && item.page >= 1)
    .sort((a, b) => (a.page as number) - (b.page as number));
  if (items.length < 2) return null;

  // Collapse duplicate start pages (keep the first title).
  const starts: { title: string; page: number }[] = [];
  for (const item of items) {
    const page = item.page as number;
    const last = starts[starts.length - 1];
    if (!last || last.page !== page) starts.push({ title: item.title, page });
  }
  if (starts.length < 2) return null;

  return buildDraftsFromStarts(lines, starts);
}

function normalizeLead(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 48)
    .trim();
}

const TOC_LINE_RE = /^(.{3,90}?)[\s.·•…]{2,}(\d{1,4})\s*$/;

/** Pulls "Title .... 123" style table-of-contents entries from the front matter. */
function tocEntriesFromLines(lines: DocLine[]): { title: string; printedPage: number }[] {
  const entries: { title: string; printedPage: number }[] = [];
  const seen = new Set<string>();

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
function chaptersFromToc(lines: DocLine[]): ChapterDraft[] | null {
  const entries = tocEntriesFromLines(lines);
  if (entries.length < 4) return null;

  const matched: { title: string; printedPage: number; pdfPage: number }[] = [];
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
  const offsetCounts = new Map<number, number>();
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

  const unique: { title: string; page: number }[] = [];
  for (const start of starts) {
    const last = unique[unique.length - 1];
    if (last && start.page <= last.page) continue;
    unique.push(start);
  }
  if (unique.length < 3) return null;

  return buildDraftsFromStarts(lines, unique);
}

function splitIntoChapters(lines: DocLine[], outline: OutlineItem[]): ChapterDraft[] {
  const fromOutline = chaptersFromOutline(lines, outline);
  if (fromOutline) return fromOutline;

  const fromToc = chaptersFromToc(lines);
  if (fromToc) return fromToc;

  const candidates: { lineIndex: number; title: string }[] = [];
  const seenTitles = new Set<string>();

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
    const segments: ChapterDraft[] = [];
    for (let i = 0; i < candidates.length && segments.length < MAX_CHAPTERS; i++) {
      const start = candidates[i].lineIndex + 1;
      const end = i + 1 < candidates.length ? candidates[i + 1].lineIndex : lines.length;
      segments.push(toChapterDraft(candidates[i].title, lines.slice(start, end)));
    }

    // Merge near-empty segments (usually mis-detected headings) into the previous chapter.
    const merged: ChapterDraft[] = [];
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

// ── main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  );

  let bookId: string | null = null;

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData?.user;
    if (userError || !user) {
      return jsonResponse({ error: 'You must be signed in to add a book.' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;

    let lines: DocLine[];
    let outline: OutlineItem[] = [];
    let fileHash: string;

    if (body.mode === 'text') {
      // ---- pasted-text mode ------------------------------------------------
      const title = (body.title ?? '').trim();
      const subject = (body.subject ?? '').trim() || 'General';
      const author = (body.author ?? '').trim() || null;
      const text = normalizeText(body.text ?? '');

      if (!title) return jsonResponse({ error: 'A title is required.' }, 400);
      if (text.length < MIN_TEXT_LENGTH) {
        return jsonResponse({ error: 'That text is too short to build a book from.' }, 400);
      }

      fileHash = await sha256Hex(text);
      const { data: duplicate } = await supabase
        .from('books')
        .select('id, title')
        .eq('owner_id', user.id)
        .eq('file_hash', fileHash)
        .limit(1)
        .maybeSingle();
      if (duplicate) {
        return jsonResponse(
          {
            error: `You have already uploaded this text as "${duplicate.title}". Delete that copy first if you want to re-upload it.`,
          },
          409,
        );
      }

      lines = text.split('\n').map((line) => ({ text: line.trim(), page: null })).filter((line) => line.text.length > 0);

      const { data: book, error: bookError } = await supabase
        .from('books')
        .insert({
          title,
          subject,
          author,
          owner_id: user.id,
          is_default: false,
          status: 'ready',
          file_hash: fileHash,
        })
        .select('id')
        .single();

      if (bookError || !book) {
        return jsonResponse({ error: `Could not create the book: ${bookError?.message}` }, 500);
      }
      bookId = book.id as string;
    } else {
      // ---- file mode -------------------------------------------------------
      if (!body.bookId) return jsonResponse({ error: 'bookId is required.' }, 400);
      bookId = body.bookId;

      const { data: book, error: bookError } = await supabase
        .from('books')
        .select('id, owner_id, file_path, file_type')
        .eq('id', bookId)
        .single();

      if (bookError || !book) {
        return jsonResponse({ error: 'Book not found.' }, 404);
      }
      if (book.owner_id !== user.id) {
        return jsonResponse({ error: 'You can only process your own uploads.' }, 403);
      }
      if (!book.file_path || !book.file_type) {
        return jsonResponse({ error: 'This book has no file attached.' }, 400);
      }

      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from('books')
        .download(book.file_path);

      if (downloadError || !fileBlob) {
        throw new Error(`Could not download the file: ${downloadError?.message ?? 'unknown error'}`);
      }

      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      fileHash = await sha256Hex(bytes);

      // Duplicate detection: same owner + same file fingerprint.
      const { data: duplicate } = await supabase
        .from('books')
        .select('id, title')
        .eq('owner_id', user.id)
        .eq('file_hash', fileHash)
        .limit(1)
        .maybeSingle();
      if (duplicate) {
        return jsonResponse(
          {
            error: `You have already uploaded this file as "${duplicate.title}". Delete that copy first if you want to re-upload it.`,
          },
          409,
        );
      }

      const kind = book.file_type as FileKind;
      if (kind === 'pdf') {
        const extracted = await extractPdf(bytes);
        lines = extracted.lines;
        outline = extracted.outline;

        const textLength = lines.reduce((sum, line) => sum + line.text.length, 0);
        if (textLength < 500) {
          // Scanned PDF: hand it to the OCR worker instead of failing.
          const { error: jobError } = await supabase.from('jobs').insert({
            user_id: user.id,
            type: 'ingest_book',
            payload: { bookId, ocr: true },
          });
          if (jobError) {
            throw new Error(
              `This PDF needs OCR, but the job could not be queued: ${jobError.message}`,
            );
          }
          await supabase
            .from('books')
            .update({
              status: 'queued',
              status_message: 'Scanned PDF — waiting for the OCR worker.',
            })
            .eq('id', bookId);
          return jsonResponse({ bookId, chapters: 0, queued: true });
        }
      } else if (kind === 'epub') {
        const text = normalizeText(extractEpubText(bytes));
        lines = text.split('\n').map((line) => ({ text: line.trim(), page: null })).filter((line) => line.text.length > 0);
      } else {
        const text = normalizeText(new TextDecoder('utf-8').decode(bytes));
        lines = text.split('\n').map((line) => ({ text: line.trim(), page: null })).filter((line) => line.text.length > 0);
      }

      // Store the fingerprint on the book row (also marks it ready below).
      const { error: hashError } = await supabase
        .from('books')
        .update({ file_hash: fileHash })
        .eq('id', bookId);
      if (hashError) throw new Error(`Could not save the file fingerprint: ${hashError.message}`);
    }

    const totalChars = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      // Truncate at the line level to keep page maps valid.
      let accumulated = 0;
      lines = lines.filter((line) => {
        accumulated += line.text.length + 1;
        return accumulated <= MAX_TOTAL_CHARS;
      });
    }

    const chapters = splitIntoChapters(lines, outline);
    if (chapters.length === 0) {
      throw new Error('No readable text was found in this book.');
    }

    // Insert chapters in batches to keep request sizes sane.
    const BATCH_SIZE = 5;
    let inserted = 0;
    for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
      const batch = chapters.slice(i, i + BATCH_SIZE).map((chapter, offset) => ({
        book_id: bookId,
        number: i + offset + 1,
        title: chapter.title || `Chapter ${i + offset + 1}`,
        content: chapter.content,
        first_page: chapter.firstPage,
        last_page: chapter.lastPage,
        page_map: chapter.pageMap.length > 0 ? chapter.pageMap : null,
      }));
      const { error: insertError } = await supabase.from('chapters').insert(batch);
      if (insertError) throw new Error(`Could not save chapters: ${insertError.message}`);
      inserted += batch.length;
    }

    await supabase
      .from('books')
      .update({ status: 'ready', status_message: null })
      .eq('id', bookId);

    return jsonResponse({ bookId, chapters: inserted });
  } catch (err) {
    const message = errorMessage(err, 'Could not process this book.');

    // Best-effort: mark the book as failed so the UI can explain what happened.
    if (bookId) {
      try {
        await supabase
          .from('books')
          .update({ status: 'error', status_message: message.slice(0, 500) })
          .eq('id', bookId);
      } catch {
        // Ignore — we still want to return the original error below.
      }
    }

    return jsonResponse({ error: message }, 500);
  }
});
