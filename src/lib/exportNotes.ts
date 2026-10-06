// Builds a Markdown revision document from the reader's highlights & notes
// and hands it to the platform: a file download in the browser, the share
// sheet on native. No extra dependencies — RN's Share is enough.

import { Platform, Share } from 'react-native';

import type { ReaderNote } from '@/lib/api';

/** Groups notes by chapter and renders a Markdown revision sheet. */
export function buildNotesMarkdown(bookTitle: string, notes: ReaderNote[]): string {
  const sorted = [...notes].sort((a, b) => {
    const chapterDiff = (a.chapter_number ?? 0) - (b.chapter_number ?? 0);
    return chapterDiff !== 0 ? chapterDiff : a.paragraph_index - b.paragraph_index;
  });

  const lines: string[] = [];
  lines.push(`# ${bookTitle}`);
  lines.push('');
  const highlightCount = notes.filter((note) => note.kind === 'highlight').length;
  const noteCount = notes.length - highlightCount;
  const stamp = new Date().toLocaleDateString();
  lines.push(
    `_Exported from Athena · ${highlightCount} highlight${highlightCount === 1 ? '' : 's'} · ${noteCount} note${noteCount === 1 ? '' : 's'} · ${stamp}_`,
  );
  lines.push('');

  let currentChapter: string | null = null;
  for (const note of sorted) {
    const chapterLabel = `Ch. ${note.chapter_number ?? '?'} · ${note.chapter_title ?? 'Untitled'}`;
    if (chapterLabel !== currentChapter) {
      lines.push(`## ${chapterLabel}`);
      lines.push('');
      currentChapter = chapterLabel;
    }
    if (note.kind === 'note' && note.note) {
      lines.push(`- **Note:** ${note.note.trim()}`);
      if (note.text) {
        lines.push(`  > ${note.text.trim()}`);
      }
    } else if (note.text) {
      lines.push(`- > ${note.text.trim()}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'athena-notes'
  );
}

/** Downloads (web) or shares (native) the notes document. */
export async function exportNotesMarkdown(bookTitle: string, notes: ReaderNote[]): Promise<void> {
  const markdown = buildNotesMarkdown(bookTitle, notes);
  if (Platform.OS !== 'web') {
    await Share.share({ message: markdown, title: `${bookTitle} — notes` });
    return;
  }

  type Doc = {
    createElement: (tag: string) => { href: string; download: string; click: () => void };
    createObjectURL: (blob: unknown) => string;
    revokeObjectURL: (url: string) => void;
  };
  const doc = (globalThis as unknown as { document?: Doc }).document;
  const BlobCtor = (
    globalThis as unknown as { Blob?: new (parts: string[], options: { type: string }) => unknown }
  ).Blob;
  if (!doc || !BlobCtor) {
    await Share.share({ message: markdown, title: `${bookTitle} — notes` }).catch(() => {});
    return;
  }
  const url = doc.createObjectURL(new BlobCtor([markdown], { type: 'text/markdown' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = `${slugify(bookTitle)}-notes.md`;
  link.click();
  doc.revokeObjectURL(url);
}
