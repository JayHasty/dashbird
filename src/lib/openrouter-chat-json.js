/**
 * Shared OpenRouter chat/completions helper (JSON mode).
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-20b:free';
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-4o-mini',
];

/** @type {number} */
let rateLimitUntilMs = 0;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} keys
 */
function envFirst(env, keys) {
  for (const key of keys) {
    const v = String(env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return (
    envFirst(env, [
      'GMAIL_DAILY_SUMMARY_MODEL',
      'GMAIL_WEEKLY_SUMMARY_MODEL',
      'OPENROUTER_FREE_TEXT_MODEL',
    ]) || DEFAULT_TEXT_MODEL
  );
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([primary, ...fallbacks].map((m) => String(m || '').trim()).filter(Boolean))];
}

/**
 * @param {unknown} content
 */
function extractJsonObject(content) {
  const raw = String(content || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 401 = bad/revoked key (stop). 403 is usually per-model (privacy/ToS/region) — try the next slug.
 * @param {number} status
 */
export function openRouterShouldRetryStatus(status) {
  const s = Number(status);
  if (s === 401) return false;
  if (s === 400 || s === 402 || s === 403 || s === 404 || s === 408 || s === 429) return true;
  if (s >= 500) return true;
  return false;
}

/**
 * @param {Response} r
 */
async function errorSnippet(r) {
  const text = await r.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message || j?.message || '';
    return String(msg).replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch {
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 180);
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function httpReferer(env = process.env) {
  return (
    String(env.OPENROUTER_HTTP_REFERER || '').trim()
    || 'https://dashbird.jayhasty.com'
  );
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{
 *   ignoreRateLimit?: boolean,
 *   timeoutMs?: number,
 *   models?: string[],
 *   backoff429?: boolean,
 *   xTitle?: string,
 *   maxTokens?: number,
 * }} [opts]
 */
export async function openRouterChatJson(env, messages, opts = {}) {
  if (!openRouterKey(env)) {
    return { ok: false, error: 'openrouter_not_configured' };
  }
  if (!opts.ignoreRateLimit && Date.now() < rateLimitUntilMs) {
    return { ok: false, error: 'openrouter_http_429' };
  }
  const models =
    Array.isArray(opts.models) && opts.models.length
      ? modelChain(opts.models[0], opts.models.slice(1))
      : modelChain(textModel(env), TEXT_FALLBACK_MODELS);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 90_000, 10_000), 120_000);
  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 2500, 256), 8000);
  const xTitle =
    String(opts.xTitle || env.OPENROUTER_X_TITLE || 'dashbird-daily-summary').trim()
    || 'dashbird-daily-summary';
  const headers = {
    Authorization: `Bearer ${openRouterKey(env)}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': httpReferer(env),
    'X-Title': xTitle,
  };

  /**
   * @param {string} model
   * @param {boolean} jsonMode
   */
  async function post(model, jsonMode) {
    const body = {
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    return fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  let lastError = 'openrouter_failed';
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    let jsonMode = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let r;
      try {
        r = await post(model, jsonMode);
      } catch (e) {
        lastError = String(e?.message || e || 'openrouter_unreachable');
        break;
      }
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
        if (!parsed || typeof parsed !== 'object') {
          lastError = 'parse_failed';
          break;
        }
        rateLimitUntilMs = 0;
        return { ok: true, parsed, model: String(j?.model || model) };
      }
      const snippet = await errorSnippet(r);
      lastError = `openrouter_http_${r.status}`;
      if (snippet) {
        console.warn(`[openrouter] ${model} ${lastError}: ${snippet}`);
      }
      // Some free models reject json_object (400) — retry the same slug as plain text.
      if (r.status === 400 && jsonMode) {
        jsonMode = false;
        continue;
      }
      if (r.status === 401) {
        return { ok: false, error: lastError };
      }
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        const waitSec = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra, 2), 45) : 5;
        if (i < models.length - 1) {
          if (opts.backoff429 !== false) {
            await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
          }
          break;
        }
        rateLimitUntilMs = Date.now() + Math.max(waitSec, 60) * 1000;
        return { ok: false, error: lastError };
      }
      if (openRouterShouldRetryStatus(r.status)) break;
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError };
}

/** @returns {number} */
export function openRouterRateLimitUntilMs() {
  return rateLimitUntilMs;
}

/**
 * @param {number} untilMs
 */
export function bumpOpenRouterRateLimit(untilMs) {
  if (Number.isFinite(untilMs) && untilMs > rateLimitUntilMs) {
    rateLimitUntilMs = untilMs;
  }
}
