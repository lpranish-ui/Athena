// File picking + upload helpers that work on web, Android and iOS.
//
// The picked file is sent straight to the API, which extracts the text and
// chapters. Nothing is stored server-side afterwards.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { api } from './apiClient';

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

/** Reads the picked file into bytes for upload. */
async function readFileBytes(picked: PickedBookFile): Promise<Uint8Array> {
  if (Platform.OS === 'web') {
    const response = await fetch(picked.uri);
    return new Uint8Array(await response.arrayBuffer());
  }
  try {
    return await new File(picked.uri).bytes();
  } catch {
    throw new Error('Could not read the selected file. Please try picking it again.');
  }
}

/**
 * Sends a book file to the API, which extracts the text, splits the chapters
 * and marks the book ready. The raw file is not kept on the server.
 */
export async function uploadBookFile(
  bookId: string,
  picked: PickedBookFile,
): Promise<{ bookId: string; chapters: number }> {
  const bytes = await readFileBytes(picked);
  return api.upload<{ bookId: string; chapters: number }>(
    `/api/upload/${bookId}`,
    bytes,
    picked.fileType,
  );
}
