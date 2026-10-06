// Creates public share links (quiz / deck / highlight) and hands the URL to
// the platform: the native share sheet, the Web Share API, or the clipboard.

import { Platform, Share } from 'react-native';

import { api } from './apiClient';

export type ShareKind = 'set' | 'deck' | 'note';

/** Absolute URL for a share token (falls back to a path off-web). */
export function shareUrl(token: string): string {
  const location = (globalThis as unknown as { location?: { origin?: string } }).location;
  const origin = location?.origin ?? '';
  return `${origin}/s/${token}`;
}

/** Creates the public snapshot link and returns the shareable URL. */
export async function createShareUrl(kind: ShareKind, id: string): Promise<string> {
  const result = await api.post<{ token: string }>('/api/shares', { kind, id });
  return shareUrl(result.token);
}

/** Shares via the platform sheet or copies to the clipboard. */
export async function shareLink(title: string, url: string): Promise<'shared' | 'copied'> {
  if (Platform.OS !== 'web') {
    await Share.share({ message: `${title}\n${url}`, title });
    return 'shared';
  }
  const nav = (
    globalThis as unknown as {
      navigator?: {
        share?: (data: { title?: string; url?: string }) => Promise<void>;
        clipboard?: { writeText: (text: string) => Promise<void> };
      };
    }
  ).navigator;
  if (nav?.share) {
    try {
      await nav.share({ title, url });
      return 'shared';
    } catch {
      // User dismissed the sheet or share is unsupported — fall back to copy.
    }
  }
  if (nav?.clipboard) {
    await nav.clipboard.writeText(url);
    return 'copied';
  }
  const promptFn = (
    globalThis as unknown as { prompt?: (message: string, value: string) => unknown }
  ).prompt;
  promptFn?.('Copy this link', url);
  return 'copied';
}

/** Snapshot + share in one call; returns the URL (and how it was delivered). */
export async function shareContent(
  kind: ShareKind,
  id: string,
  title: string,
): Promise<{ url: string; method: 'shared' | 'copied' }> {
  const url = await createShareUrl(kind, id);
  const method = await shareLink(title, url);
  return { url, method };
}
