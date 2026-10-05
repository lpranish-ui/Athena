// ============================================================================
// DeepSeek client for the API — every AI call in the server goes through here.
// ============================================================================
// Swapping providers means editing only this module. DeepSeek uses the
// OpenAI-compatible chat completions format.
//
// Model selection: DEEPSEEK_MODEL environment variable (default deepseek-flash,
// the cheapest model). Raise it any time on Render — no code changes:
//   DEEPSEEK_MODEL=deepseek-v4-pro
//
// Node port of supabase/functions/_shared/ai.ts (usage is logged to ai_calls
// with a plain SQL insert instead of a Supabase client).

import { query } from './db.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-flash';
// Hard cap per AI call. Without this, a silently-dropped connection to
// DeepSeek makes the request hang until the OS gives up (minutes!).
const CALL_TIMEOUT_MS = 60_000;

export class MissingKeyError extends Error {
  constructor() {
    super(
      'The server is missing its DEEPSEEK_API_KEY. An admin can add it in the Render dashboard under the athena-api service → Environment.',
    );
    this.name = 'MissingKeyError';
  }
}

export function getModel() {
  return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
}

/** Model used for the blind answer-check (a cheaper model is fine and preferred). */
export function getVerifyModel() {
  return process.env.DEEPSEEK_VERIFY_MODEL?.trim() || 'deepseek-flash';
}

/** Records token usage in `ai_calls` — best effort, never breaks a request. */
async function logAiCall(meta, model, usage) {
  if (!meta || !usage) return;
  try {
    await query(
      `insert into ai_calls (user_id, purpose, model, prompt_tokens, completion_tokens, cache_hit_tokens)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        meta.userId ?? null,
        meta.purpose,
        model,
        usage.prompt_tokens ?? null,
        usage.completion_tokens ?? null,
        usage.prompt_cache_hit_tokens ?? null,
      ],
    );
  } catch {
    // Usage logging is best-effort — it must never break a request.
  }
}

/**
 * Sends a chat request and returns the raw message content.
 * Uses JSON mode; retries once — both for empty content (see DeepSeek's JSON
 * mode docs) and for network stalls (a timed-out attempt is retried on a
 * fresh connection). Non-retryable API errors (bad key, no balance…) throw
 * immediately.
 */
export async function chatJson({
  messages,
  maxTokens = 8000,
  temperature = 0.5,
  model: modelOverride,
  meta,
  timeoutMs = CALL_TIMEOUT_MS,
}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new MissingKeyError();

  const model = modelOverride?.trim() || getModel();
  let lastError = 'The AI returned an empty response.';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: 'json_object' },
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 300);
        const error = new Error(`The AI service returned an error (${response.status}). ${details}`);
        error.status = response.status;
        throw error;
      }

      const completion = await response.json();
      const content = completion?.choices?.[0]?.message?.content ?? '';
      if (content.trim().length > 0) {
        console.log(`ai call ok model=${model} attempt=${attempt} ms=${Date.now() - startedAt}`);
        await logAiCall(meta, model, completion?.usage);
        return content;
      }
      lastError = 'The AI returned an empty response.';
      console.error(`ai call empty model=${model} attempt=${attempt} ms=${Date.now() - startedAt}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'The AI request failed.';
      const status = typeof error === 'object' && error !== null ? error.status : undefined;
      console.error(
        `ai call failed model=${model} attempt=${attempt} ms=${Date.now() - startedAt} status=${status ?? '-'} error=${lastError}`,
      );
      // The API itself rejected us (bad key, out of balance, bad model…) —
      // retrying will not help.
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        throw error;
      }
      // Timeout / dropped connection / 5xx: retry once on a fresh connection.
    }
  }

  if (lastError === 'The AI returned an empty response.') throw new Error(lastError);
  throw new Error(`The AI service did not respond in time (${lastError}). Please try again.`);
}
