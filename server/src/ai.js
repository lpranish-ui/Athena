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
 * Pulls the first balanced {...} JSON object out of a string (best effort).
 * Used to salvage answers DeepSeek puts in reasoning_content instead of the
 * message content (a flash-model quirk that shows up as "empty" responses).
 */
function extractJsonObject(text) {
  if (!text) return null;
  let searchFrom = 0;
  for (let tries = 0; tries < 40; tries++) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end !== -1) {
      const candidate = text.slice(start, end + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed !== null && typeof parsed === 'object') return candidate;
      } catch {
        // Not valid JSON - keep scanning for the next brace.
      }
    }
    searchFrom = start + 1;
  }
  return null;
}

/**
 * Sends a chat request and returns the raw message content.
 * Robustness layers, in order:
 *   1. Thinking mode is ON by default — it is what makes the model quote the
 *      chapter word-for-word. The empty-response failure happened when the
 *      model's reasoning exhausted the caller's max_tokens budget, so calls
 *      with chapter-sized prompts pass a large budget (20000+). Callers that
 *      only need fast structured JSON can pass thinking: 'disabled' (~10x
 *      faster, verified, but paraphrases quotes — not for question writing).
 *   2. 3 attempts total. Attempts 1-2 use JSON mode; the final attempt drops
 *      response_format entirely (belt and braces).
 *   3. A stalled/timed-out attempt is retried on a fresh connection.
 *   4. If the content is empty but reasoning_content holds a parseable JSON
 *      object, that object is salvaged instead of failing.
 * Non-retryable API errors (bad key, no balance…) throw immediately.
 */
export async function chatJson({
  messages,
  maxTokens = 8000,
  temperature = 0.5,
  model: modelOverride,
  meta,
  timeoutMs = CALL_TIMEOUT_MS,
  thinking: thinkingMode = 'auto',
}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new MissingKeyError();

  // DeepSeek JSON mode requires an explicit JSON instruction, even when the
  // caller already supplied a JSON-shaped schema. Work on fresh objects so
  // retries and other calls cannot mutate the caller's cached prompt.
  const requestMessages = messages.map((message) => ({ ...message }));
  const instruction = 'Return one valid JSON object only. Do not include markdown fences or commentary.';
  const systemIndex = requestMessages.findIndex((message) => message.role === 'system' && typeof message.content === 'string');
  if (systemIndex >= 0) {
    requestMessages[systemIndex].content += `\n${instruction}`;
  } else {
    requestMessages.unshift({ role: 'system', content: instruction });
  }

  const model = modelOverride?.trim() || getModel();
  let lastError = 'The AI returned an empty response.';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = Date.now();
    // DeepSeek's JSON mode occasionally yields an empty message (its docs
    // recommend retrying). The final attempt drops JSON mode entirely - the
    // prompts already demand strict JSON and the parsers extract the first
    // {...} block, so this path is still safe to parse.
    const useJsonMode = attempt < 3;
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          // Thinking ON (default) makes the model copy chapter text verbatim
          // in its supporting quotes. It costs 20-40s on chapter-sized
          // prompts, so the reasoning must have headroom below max_tokens —
          // when reasoning exhausts the budget the content comes back EMPTY.
          ...(thinkingMode === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
          ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
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
      const choice = completion?.choices?.[0];
      const content = choice?.message?.content ?? '';
      if (content.trim().length > 0) {
        console.log(`ai call ok model=${model} attempt=${attempt} jsonMode=${useJsonMode} ms=${Date.now() - startedAt}`);
        await logAiCall(meta, model, completion?.usage);
        return content;
      }

      // Empty content: DeepSeek sometimes tucks the answer into
      // reasoning_content (or truncates before emitting any). Salvage a
      // parseable JSON object from the reasoning as a best effort.
      const reasoning = choice?.message?.reasoning_content ?? '';
      const salvaged = extractJsonObject(reasoning);
      if (salvaged) {
        console.log(`ai call ok-salvaged model=${model} attempt=${attempt} jsonMode=${useJsonMode} ms=${Date.now() - startedAt}`);
        await logAiCall(meta, model, completion?.usage);
        return salvaged;
      }

      lastError = 'The AI returned an empty response.';
      console.error(
        `ai call empty model=${model} attempt=${attempt} jsonMode=${useJsonMode} finish=${choice?.finish_reason ?? '-'} completion_tokens=${completion?.usage?.completion_tokens ?? '-'} reasoning_chars=${reasoning.length} ms=${Date.now() - startedAt}`,
      );
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

  if (lastError === 'The AI returned an empty response.') {
    throw new Error('The AI service returned an empty response after several attempts. Please try again in a moment.');
  }
  throw new Error(`The AI service did not respond in time (${lastError}). Please try again.`);
}
