// REST client for the Athena API — replaces the supabase-js client.
//
// Reads EXPO_PUBLIC_API_URL from `.env` (e.g. https://athena-api-w018.onrender.com).
// The sign-in token is kept in AsyncStorage and sent as a Bearer header.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchText } from './request';

const rawBase = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();
export const API_URL = rawBase.replace(/\/+$/, '');
export const isApiConfigured = /^https?:\/\/.+/.test(API_URL);

const TOKEN_KEY = 'athena.auth.token';
const USER_KEY = 'athena.auth.user';

export interface StoredUser {
  id: string;
  email: string;
}

let cachedToken: string | null | undefined;

/** Reads the persisted sign-in token (cached after the first read). */
export async function loadToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = (await AsyncStorage.getItem(TOKEN_KEY)) ?? null;
  return cachedToken;
}

export async function saveToken(token: string | null): Promise<void> {
  cachedToken = token;
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

/** The user object is cached too, so the app can open offline. */
export async function loadStoredUser(): Promise<StoredUser | null> {
  const raw = await AsyncStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredUser;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveStoredUser(user: StoredUser | null): Promise<void> {
  if (user) await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
  else await AsyncStorage.removeItem(USER_KEY);
}

/** An error from the API with its HTTP status (0 = network unreachable). */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  /** Overrides the token resolution (null = send no Authorization header). */
  token?: string | null;
  body?: unknown;
  raw?: Uint8Array | ArrayBuffer;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Performs a request against the Athena API.
 * Throws `ApiError` with a user-friendly message on any failure.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = options.token !== undefined ? options.token : await loadToken();

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Awaited<ReturnType<typeof fetchText>>;
  try {
    const timeoutMs = options.timeoutMs ??
      (path.startsWith('/api/ai/') || path.endsWith('/ask') ? 600000 : 30000);
    response = await fetchText(`${API_URL}${path}`, { method, headers, body }, timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new ApiError(
      0,
      `Could not reach the Athena server. Check your connection and try again.${detail ? ` (${detail})` : ''}`,
    );
  }

  const text = response.text;
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const fromBody =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : null;
    throw new ApiError(response.status, fromBody ?? `Request failed (${response.status}).`);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string, token?: string | null) => apiRequest<T>('GET', path, { token }),
  post: <T>(path: string, body?: unknown, token?: string | null) =>
    apiRequest<T>('POST', path, { body, token }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body }),
  del: <T>(path: string) => apiRequest<T>('DELETE', path, {}),
  /** Uploads a raw book file (nothing is stored server-side). */
  upload: <T>(path: string, bytes: Uint8Array | ArrayBuffer, fileType: string) =>
    apiRequest<T>('POST', path, {
      raw: bytes,
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-type': fileType },
      timeoutMs: 300000,
    }),
};
