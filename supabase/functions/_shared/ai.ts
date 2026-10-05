// ============================================================================
// Athena AI module — every AI call in the app goes through this file.
// ============================================================================
// Swapping providers (OpenAI, Anthropic, a local model...) means editing only
// this module. DeepSeek uses the OpenAI-compatible chat completions format.
//
// Model selection: `DEEPSEEK_MODEL` secret (defaults to deepseek-v4-pro).
//   supabase secrets set DEEPSEEK_MODEL=deepseek-flash   # cheaper option

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';

export class MissingKeyError extends Error {
  constructor() {
    super(
      'The server is missing its DEEPSEEK_API_KEY secret. An admin can fix this with: supabase secrets set DEEPSEEK_API_KEY=sk-...',
    );
    this.name = 'MissingKeyError';
  }
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function getModel(): string {
  return Deno.env.get('DEEPSEEK_MODEL')?.trim() || DEFAULT_MODEL;
}

/** Model used for the blind answer-check (a cheaper model is fine and preferred). */
export function getVerifyModel(): string {
  return Deno.env.get('DEEPSEEK_VERIFY_MODEL')?.trim() || 'deepseek-flash';
}

export interface AiCallLog {
  /** Supabase client (user-scoped) used to record usage in `ai_calls`. */
  client: unknown;
  userId?: string;
  purpose: string;
}

async function logAiCall(
  meta: AiCallLog | undefined,
  model: string,
  usage:
    | { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }
    | undefined,
): Promise<void> {
  if (!meta || !usage) return;
  try {
    const client = meta.client as {
      from: (table: string) => { insert: (row: Record<string, unknown>) => PromiseLike<unknown> };
    };
    await client.from('ai_calls').insert({
      user_id: meta.userId ?? null,
      purpose: meta.purpose,
      model,
      prompt_tokens: usage.prompt_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? null,
      cache_hit_tokens: usage.prompt_cache_hit_tokens ?? null,
    });
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
}: {
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
  meta?: AiCallLog;
}): Promise<string> {
  const key = Deno.env.get('DEEPSEEK_API_KEY');
  if (!key) throw new MissingKeyError();

  const model = modelOverride?.trim() || getModel();
  let lastError = 'The AI returned an empty response.';

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
    const content: string = completion?.choices?.[0]?.message?.content ?? '';
    if (content.trim().length > 0) {
      await logAiCall(meta, model, completion?.usage);
      return content;
    }
  }

  throw new Error(lastError);
}
