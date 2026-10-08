// Private downloads are account-scoped and invalidated immediately on logout.
import type { Book, ChapterSummary } from '@/types';
import { api, loadToken } from './apiClient';
import { privateOffline } from './privateOffline';
import type { OfflineAccountLease } from './offlineStorage';

export { clearPrivateOfflineData, setOfflineAccount } from './privateOffline';
export { isOfflineNetworkError } from './offlineStorage';
export const captureOfflineAccount = () => privateOffline.lease();
export const assertOfflineAccount = (lease: OfflineAccountLease) => privateOffline.assertCurrent(lease);

export interface OfflineChapterContent { id: string; title: string; content: string; number?: number }
export interface OfflineBookMeta { book: Book; chapters: ChapterSummary[]; savedAt: string; bytes: number }
const bookPath = (bookId: string) => `books.${encodeURIComponent(bookId)}.`;
const metaKey = (bookId: string) => `${bookPath(bookId)}meta`;
const chapterKey = (bookId: string, chapterId: string) => `${bookPath(bookId)}ch.${encodeURIComponent(chapterId)}`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function getOfflineMeta(bookId: string, lease = privateOffline.lease()): Promise<OfflineBookMeta | null> {
  return privateOffline.read<OfflineBookMeta>(lease, metaKey(bookId));
}

/** The manifest is written last, so interrupted downloads cannot be opened. */
export async function downloadBook(bookId: string, onProgress?: (done: number, total: number) => void): Promise<OfflineBookMeta> {
  const lease = privateOffline.lease();
  const token = await loadToken();
  privateOffline.assertCurrent(lease);
  const book = await api.get<Book>(`/api/books/${bookId}`, token);
  privateOffline.assertCurrent(lease);
  const chapters = await api.get<ChapterSummary[]>(`/api/books/${bookId}/chapters`, token);
  privateOffline.assertCurrent(lease);
  await privateOffline.remove(lease, [metaKey(bookId)]);
  onProgress?.(0, chapters.length);
  let bytes = 0;
  let done = 0;
  for (const chapter of chapters) {
    const data = await api.get<OfflineChapterContent>(`/api/chapters/${chapter.id}`, token);
    await privateOffline.write(lease, chapterKey(bookId, chapter.id), {
      id: data.id, title: data.title, content: data.content, number: data.number,
    } satisfies OfflineChapterContent);
    for (const character of data.content) {
      const code = character.codePointAt(0)!;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    done += 1;
    onProgress?.(done, chapters.length);
  }
  const meta: OfflineBookMeta = { book, chapters, savedAt: new Date().toISOString(), bytes };
  await privateOffline.write(lease, metaKey(bookId), meta);
  return meta;
}

/** Removes partial downloads as well as manifest-listed chapters. */
export async function deleteOfflineBook(bookId: string, lease = privateOffline.lease()): Promise<void> {
  await privateOffline.remove(lease, await privateOffline.list(lease, bookPath(bookId)));
}

export async function listOfflineBooks(lease = privateOffline.lease()): Promise<OfflineBookMeta[]> {
  const paths = (await privateOffline.list(lease, 'books.')).filter((path) => path.endsWith('.meta'));
  const metas = await Promise.all(paths.map((path) => privateOffline.read<OfflineBookMeta>(lease, path)));
  return metas.filter((meta): meta is OfflineBookMeta => !!meta);
}

export async function readOfflineChapter(bookId: string, chapterId: string, lease = privateOffline.lease()): Promise<OfflineChapterContent | null> {
  const meta = await getOfflineMeta(bookId, lease);
  if (!meta?.chapters.some((chapter) => chapter.id === chapterId)) return null;
  return privateOffline.read<OfflineChapterContent>(lease, chapterKey(bookId, chapterId));
}
