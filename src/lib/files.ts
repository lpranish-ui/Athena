// File picking + upload helpers that work on web, Android and iOS.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from './supabase';

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

/** Reads the picked file into something supabase-js can upload. */
async function readFileBody(picked: PickedBookFile): Promise<Blob | Uint8Array> {
  if (Platform.OS === 'web') {
    const response = await fetch(picked.uri);
    return await response.blob();
  }
  try {
    return new File(picked.uri).bytes();
  } catch {
    throw new Error('Could not read the selected file. Please try picking it again.');
  }
}

/**
 * Uploads a book file to the private `books` storage bucket.
 * Files live under `{userId}/{bookId}.{ext}` and are only readable by their owner.
 */
export async function uploadBookFile(
  userId: string,
  bookId: string,
  picked: PickedBookFile,
): Promise<string> {
  const path = `${userId}/${bookId}.${picked.fileType}`;
  const body = await readFileBody(picked);

  const { error } = await supabase.storage
    .from('books')
    .upload(path, body, { contentType: MIME_TYPES[picked.fileType], upsert: true });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }
  return path;
}
