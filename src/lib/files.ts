// File picking + upload helpers that work on web, Android and iOS.
//
// The picked file is sent straight to the API, which extracts the text and
// chapters. Durable server chunks are removed after processing.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { api, apiRequest, ApiError } from './apiClient';

export type FileKind = 'pdf' | 'epub' | 'txt';

export interface PickedBookFile {
  uri: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  fileType: FileKind;
}

const MIME_TYPES: Record<FileKind, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  txt: 'text/plain',
};

function detectFileKind(name: string, mimeType?: string | null): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === MIME_TYPES.pdf) return 'pdf';
  if (lower.endsWith('.epub') || mimeType === MIME_TYPES.epub) return 'epub';
  if (lower.endsWith('.txt') || mimeType === MIME_TYPES.txt) return 'txt';
  return null;
}

/** Opens the platform file picker and returns the chosen book file. */
export async function pickBookFile(): Promise<PickedBookFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [MIME_TYPES.pdf, MIME_TYPES.epub, MIME_TYPES.txt],
    copyToCacheDirectory: true,
    multiple: false,
    base64: false,
  });

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  const fileType = detectFileKind(asset.name, asset.mimeType);
  if (!fileType) {
    throw new Error('Unsupported file type. Please choose a PDF, EPUB or TXT file.');
  }

  return {
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? null,
    mimeType: asset.mimeType ?? MIME_TYPES[fileType],
    fileType,
  };
}

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per request

export interface UploadProgress {
  phase: 'uploading' | 'processing';
  sentBytes: number;
  totalBytes: number;
  note?: string;
}

// On web, the picked file lives behind a blob: URL — keep the blob around so
// slicing chunks does not re-fetch it every time.
let webBlobCache: { uri: string; blob: Blob } | null = null;

async function totalSizeOf(picked: PickedBookFile): Promise<number> {
  if (picked.size && picked.size > 0) return picked.size;
  if (Platform.OS === 'web') {
    const response = await fetch(picked.uri);
    const blob = await response.blob();
    webBlobCache = { uri: picked.uri, blob };
    return blob.size;
  }
  return new File(picked.uri).size ?? 0;
}

/** Reads one byte range of the picked file (web: Blob slice, native: file handle). */
async function readChunk(picked: PickedBookFile, start: number, end: number): Promise<Uint8Array> {
  const length = end - start;

  if (Platform.OS === 'web') {
    let blob = webBlobCache?.uri === picked.uri ? webBlobCache.blob : null;
    if (!blob) {
      const response = await fetch(picked.uri);
      blob = await response.blob();
      webBlobCache = { uri: picked.uri, blob };
    }
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  const file = new File(picked.uri);
  try {
    const handle = file.open();
    try {
      handle.offset = start;
      const bytes = handle.readBytes(length);
      if (bytes && bytes.length > 0) return bytes;
    } finally {
      handle.close();
    }
  } catch {
    // Random access is not available for this file provider — fall back to
    // reading the whole file (fine for small books).
  }
  if ((file.size ?? picked.size ?? Infinity) > CHUNK_SIZE) {
    throw new Error('This file provider does not support streaming. Save the book to this device and pick the local copy.');
  }
  const all = await file.bytes();
  return all.slice(start, end);
}

/**
 * Uploads a book file within the server's configured limit (512 MB by default):
 * creates the book, streams it in 8 MB chunks with bounded phone memory, then hands it to the
 * server-side extractor. `onProgress` fires after every chunk and once when
 * processing starts.
 */
export async function uploadBookFile(
  picked: PickedBookFile,
  options: {
    title?: string;
    subject?: string;
    author?: string;
    onProgress?: (progress: UploadProgress) => void;
  } = {},
): Promise<{ bookId: string }> {
  const totalBytes = await totalSizeOf(picked);
  if (totalBytes <= 0) {
    throw new Error('Could not read the selected file. Please try picking it again.');
  }

  const started = await api.post<{ bookId: string }>('/api/uploads', {
    fileName: picked.name,
    title: options.title,
    subject: options.subject,
    author: options.author,
    fileSize: totalBytes,
  });
  const bookId = started.bookId;

  try {
    let sent = 0;
    while (sent < totalBytes) {
      const end = Math.min(sent + CHUNK_SIZE, totalBytes);
      const chunk = await readChunk(picked, sent, end);
      if (chunk.byteLength !== end - sent) {
        throw new Error('The selected file could not be read completely. Pick it again and retry.');
      }
      // Send an exact-length ArrayBuffer — most compatible body type across
      // react-native and browser fetch implementations.
      const body = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength,
      ) as ArrayBuffer;
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        try {
          const result = await apiRequest<{ received: number }>('PUT', `/api/uploads/${bookId}/chunk`, {
            raw: body,
            headers: { 'Content-Type': 'application/octet-stream', 'x-upload-offset': String(sent) },
            timeoutMs: 120000,
          });
          if (result.received !== end) throw new Error('The server received an unexpected amount of data. Retry the upload.');
          accepted = true;
        } catch (error) {
          if (!(error instanceof ApiError) || ![0, 409, 502, 503, 504].includes(error.status)) throw error;
          // A lost response may mean the chunk was already committed. Ask before retrying.
          const state = await api.get<{ received: number }>(`/api/uploads/${bookId}`).catch(() => null);
          if (state?.received === end) {
            accepted = true;
          } else if (state && state.received !== sent) {
            throw new Error('The server upload position changed. Pick the file again and retry.');
          } else if (attempt === 2) {
            throw error;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }
      sent = end;
      options.onProgress?.({ phase: 'uploading', sentBytes: sent, totalBytes });
    }

    try {
      await api.post(`/api/uploads/${bookId}/finish`, { size: sent });
    } catch (error) {
      const book = await api.get<{ status: string; status_message: string | null }>(`/api/books/${bookId}`).catch(() => null);
      if (!book || book.status === 'error' || book.status_message === 'Uploading…') throw error;
    }
    options.onProgress?.({ phase: 'processing', sentBytes: sent, totalBytes });
    return { bookId };
  } catch (error) {
    // Leave nothing behind on the server when a chunk fails.
    await api.del(`/api/books/${bookId}`).catch(() => {});
    throw error;
  } finally {
    webBlobCache = null;
  }
}

/** Waits while the server extracts the book; resolves when it is ready. */
export async function waitForBookReady(
  bookId: string,
  options: { onNote?: (note: string) => void; timeoutMs?: number } = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 20 * 60 * 1000;
  const startedAt = Date.now();

  for (;;) {
    const book = await api.get<{ status: string; status_message: string | null }>(
      `/api/books/${bookId}`,
    );
    if (book.status === 'ready') return;
    if (book.status === 'error') {
      throw new Error(book.status_message || 'This book could not be processed.');
    }
    if (book.status_message) options.onNote?.(book.status_message);
    if (Date.now() - startedAt > timeout) {
      throw new Error('Processing is taking longer than expected. Check the library in a minute.');
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}
