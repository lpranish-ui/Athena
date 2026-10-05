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
 * Uses JSON mode; retries once because the API may occasionally return
 * empty content (see DeepSeek's JSON mode docs).
 */
export async function chatJson({
  messages,
  maxTokens = 8000,
  temperature = 0.5,
  model: modelOverride,
  meta,
}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new MissingKeyError();

  const model = modelOverride?.trim() || getModel();

  for (let attempt = 1; attempt <= 2; attempt++) {
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
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw new Error(`The AI service returned an error (${response.status}). ${details}`);
    }

    const completion = await response.json();
    const content = completion?.choices?.[0]?.message?.content ?? '';
    if (content.trim().length > 0) {
      await logAiCall(meta, model, completion?.usage);
      return content;
    }
  }

  throw new Error('The AI returned an empty response.');
}
