// Offline reading — downloads a book's chapters into device storage so the
// reader keeps working without a connection. Web: localStorage (~5-10 MB),
// native: AsyncStorage. Chapter content is stored per chapter to keep every
// entry well under platform size limits.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Book, ChapterSummary } from '@/types';
import { api } from './apiClient';

const PREFIX = 'athena.offline.';

export interface OfflineChapterContent {
  id: string;
  title: string;
  content: string;
  number?: number;
}

export interface OfflineBookMeta {
  book: Book;
  chapters: ChapterSummary[];
  savedAt: string;
  bytes: number;
}

const metaKey = (bookId: string) => `${PREFIX}${bookId}.meta`;
const chapterKey = (bookId: string, chapterId: string) => `${PREFIX}${bookId}.ch.${chapterId}`;

/** Human-readable byte size for download badges. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Reads the offline summary for a book (null when not downloaded). */
export async function getOfflineMeta(bookId: string): Promise<OfflineBookMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(metaKey(bookId));
    return raw ? (JSON.parse(raw) as OfflineBookMeta) : null;
  } catch {
    return null;
  }
}

/** Fetches every chapter and stores it locally; meta is written last so a
 *  partial download never reports itself as complete. */
export async function downloadBook(
  bookId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<OfflineBookMeta> {
  const book = await api.get<Book>(`/api/books/${bookId}`);
  const chapters = await api.get<ChapterSummary[]>(`/api/books/${bookId}/chapters`);
  onProgress?.(0, chapters.length);
  let bytes = 0;
  let done = 0;
  for (const chapter of chapters) {
    const data = await api.get<OfflineChapterContent>(`/api/chapters/${chapter.id}`);
    await AsyncStorage.setItem(
      chapterKey(bookId, chapter.id),
      JSON.stringify({
        id: data.id,
        title: data.title,
        content: data.content,
        number: data.number,
      } satisfies OfflineChapterContent),
    );
    bytes += data.content.length;
    done += 1;
    onProgress?.(done, chapters.length);
  }
  const meta: OfflineBookMeta = { book, chapters, savedAt: new Date().toISOString(), bytes };
  await AsyncStorage.setItem(metaKey(bookId), JSON.stringify(meta));
  return meta;
}

/** Removes the offline copy (chapters + meta). */
export async function deleteOfflineBook(bookId: string): Promise<void> {
  const meta = await getOfflineMeta(bookId);
  const keys = [metaKey(bookId), ...(meta?.chapters ?? []).map((chapter) => chapterKey(bookId, chapter.id))];
  await AsyncStorage.multiRemove(keys);
}

/** Reads a stored chapter (null when missing or unreadable). */
export async function readOfflineChapter(
  bookId: string,
  chapterId: string,
): Promise<OfflineChapterContent | null> {
  try {
    const raw = await AsyncStorage.getItem(chapterKey(bookId, chapterId));
    return raw ? (JSON.parse(raw) as OfflineChapterContent) : null;
  } catch {
    return null;
  }
}
