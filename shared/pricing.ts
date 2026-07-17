/**
 * Single source of truth for model pricing.
 *
 * Two representations:
 *   MODEL_PRICING (by internal label: "opus", "sonnet46", "codex53", ...)
 *     — matches the labels used in run scripts and view data.
 *   HARBOR_MODEL_PRICING (by provider/name: "anthropic/claude-opus-4-6", ...)
 *     — matches the model IDs Harbor records in result.json.
 *
 * Prices are per-token (USD). Source: https://models.dev/api.json where
 * available; manually curated for preview/private models.
 *
 * Used by:
 *   - scripts/postprocess-costs.ts (backfill cost_usd on Harbor result.json)
 *   - extractors/extract-*-results.ts (emit costUsd into _data.js)
 *   - views/graph-gold.html, app/components/CostTable.js (display)
 */

export interface ModelPricing {
  /** USD per input token (non-cached). */
  input: number;
  /** USD per cached-input token (cache READ). */
  cachedInput: number;
  /**
   * USD per cache-WRITE (creation) token. Anthropic bills 5-min cache writes at
   * 1.25× base input; OpenAI/Gemini have no separate write premium (writes are
   * counted as normal input and these providers don't report a write bucket), so
   * for them this equals `input` and is inert.
   */
  cacheWrite: number;
  /** USD per output token. */
  output: number;
}

/** By internal label used in rs-bench2 (opus, sonnet46, gpt54, ...). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic: cacheWrite = 1.25× input (5-min ephemeral cache).
  // Fable 5: published rate card $10/M input, $50/M output (above Opus). Anthropic
  // cache: read 0.1× input, 5-min cache write 1.25× input.
  'fable-5':    { input: 10e-6,   cachedInput: 1e-6,     cacheWrite: 12.5e-6,  output: 50e-6 },
  opus48:       { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 }, // same rate card as 4.7
  'opus48-max': { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 },
  opus47:       { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 },
  opus:         { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 },
  opus45:       { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 },
  // Sonnet 5: standard rate card $3/M in, $15/M out (intro $2/$10 runs through 2026-08-31).
  // Anthropic cache: read 0.1× input, 5-min cache write 1.25× input.
  sonnet5:      { input: 3e-6,    cachedInput: 0.3e-6,   cacheWrite: 3.75e-6,  output: 15e-6 },
  // Same rate card as sonnet5 — xhigh effort just emits more thinking (billed as output).
  'sonnet5-xhigh': { input: 3e-6, cachedInput: 0.3e-6,   cacheWrite: 3.75e-6,  output: 15e-6 },
  sonnet46:     { input: 3e-6,    cachedInput: 0.3e-6,   cacheWrite: 3.75e-6,  output: 15e-6 },
  sonnet45:     { input: 3e-6,    cachedInput: 0.3e-6,   cacheWrite: 3.75e-6,  output: 15e-6 },
  haiku:        { input: 1e-6,    cachedInput: 0.1e-6,   cacheWrite: 1.25e-6,  output: 5e-6 },
  // OpenAI/Gemini/OpenRouter: no separate cache-write premium → cacheWrite = input (inert).
  codex:        { input: 1.75e-6, cachedInput: 0.175e-6, cacheWrite: 1.75e-6,  output: 14e-6 }, // gpt-5.2-codex
  codex53:      { input: 1.75e-6, cachedInput: 0.175e-6, cacheWrite: 1.75e-6,  output: 14e-6 },
  gpt54:        { input: 2.5e-6,  cachedInput: 0.25e-6,  cacheWrite: 2.5e-6,   output: 15e-6 },
  gpt54mini:    { input: 0.75e-6, cachedInput: 0.075e-6, cacheWrite: 0.75e-6,  output: 4.5e-6 },
  gpt54nano:    { input: 0.2e-6,  cachedInput: 0.02e-6,  cacheWrite: 0.2e-6,   output: 1.25e-6 },
  gpt55:        { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 5e-6,     output: 30e-6 },
  // gpt-5.6 family, released 2026-07-09. Sol matches gpt-5.5's $5/$30 rate card;
  // Luna is the new $1/$6 tier. 5.6 introduces a 1.25× cache-write premium
  // (inert unless usage reports a write bucket). xhigh variants share the base
  // rate card — higher effort just emits more reasoning tokens (billed as output).
  gpt56:        { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 30e-6 },
  'gpt56-xhigh': { input: 5e-6,   cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 30e-6 },
  gpt56luna:    { input: 1e-6,    cachedInput: 0.1e-6,   cacheWrite: 1.25e-6,  output: 6e-6 },
  'gpt56luna-xhigh': { input: 1e-6, cachedInput: 0.1e-6, cacheWrite: 1.25e-6,  output: 6e-6 },
  gemini:       { input: 2e-6,    cachedInput: 0.2e-6,   cacheWrite: 2e-6,     output: 12e-6 },
  gemini31:     { input: 2e-6,    cachedInput: 0.2e-6,   cacheWrite: 2e-6,     output: 12e-6 },
  geminiflash:  { input: 0.5e-6,  cachedInput: 0.05e-6,  cacheWrite: 0.5e-6,   output: 3e-6 },
  gemini35flash:{ input: 1.5e-6,  cachedInput: 0.15e-6,  cacheWrite: 1.5e-6,   output: 9e-6 },
  // Same per-token rates as gemini35flash — thinking_level=high just emits more
  // thinking tokens (billed as output), it doesn't change the rate card.
  'gemini35flash-high': { input: 1.5e-6, cachedInput: 0.15e-6, cacheWrite: 1.5e-6, output: 9e-6 },
  glm:          { input: 0.72e-6,   cachedInput: 0,        cacheWrite: 0.72e-6,   output: 2.3e-6 },
  glm52:        { input: 1.4e-6,    cachedInput: 0,        cacheWrite: 1.4e-6,    output: 4.4e-6 }, // z-ai/glm-5.2, OpenRouter 2026-06-16
  kimi:         { input: 0.6e-6,    cachedInput: 0.1e-6,   cacheWrite: 0.6e-6,    output: 3e-6 },
  qwen35:       { input: 0.1625e-6, cachedInput: 0,        cacheWrite: 0.1625e-6, output: 1.3e-6 },
  qwen3max:     { input: 0.78e-6,   cachedInput: 0,        cacheWrite: 0.78e-6,   output: 3.9e-6 },
  // OpenRouter listed rates as of 2026-06-09.
  // qwen3.7-max: Alibaba bills cache writes at 1.25× input (like Anthropic).
  qwen37max:    { input: 1.25e-6,   cachedInput: 0.25e-6,  cacheWrite: 1.5625e-6, output: 3.75e-6 },
  deepseek:     { input: 0.435e-6,  cachedInput: 0.003625e-6, cacheWrite: 0.435e-6, output: 0.87e-6 }, // deepseek-v4-pro
  kimi26:       { input: 0.68e-6,   cachedInput: 0.34e-6,  cacheWrite: 0.68e-6,   output: 3.41e-6 },
  kimi27:       { input: 0.75e-6,   cachedInput: 0.16e-6,  cacheWrite: 0.75e-6,   output: 3.5e-6 }, // kimi-k2.7-code, OpenRouter 2026-06-14
  kimi3:        { input: 3e-6,      cachedInput: 0.3e-6,   cacheWrite: 3e-6,      output: 15e-6 }, // kimi-k3, OpenRouter 2026-07-16 (no cache-write premium listed)
  // x-ai/grok-4.5, OpenRouter 2026-07-09. ≤200k-context rates; xAI doubles
  // rates past 200k input but our runs stay well under that.
  grok45:       { input: 2e-6,      cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // Same rate card — xhigh effort just emits more reasoning tokens (billed as output).
  'grok45-xhigh': { input: 2e-6,    cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // x-ai/grok-4.3, OpenRouter/models.dev 2026-07-09. ≤200k-context rates (2× past 200k).
  grok43:       { input: 1.25e-6,   cachedInput: 0.2e-6,   cacheWrite: 1.25e-6,   output: 2.5e-6 },
  // Inkling (Thinking Machines) via Tinker — thinkingmachines/Inkling:peft:262144,
  // the 256K variant (exactly 2× the 64K row of $1.87/$0.374/$4.68).
  // Tinker bills three meters — prefill / sample / train: prefill → input,
  // sample → output, train is N/A here (inference only). Cached prefill = 80% off.
  // No cache-write premium → cacheWrite = input (inert).
  // Rates read from https://tinker-docs.thinkingmachines.ai/tinker/models/ on
  // 2026-07-15, during a "limited-time 50% discount".
  // CAVEAT: that page also announces a ~50% prefill/sample increase effective
  // 2026-07-17 and does not state whether these figures are pre- or post-increase.
  // Re-check after 07-17; if they moved, update here AND the per-1M `cost` block
  // in agents/inkling_adapter.py, then re-extract. Note OpenCode reports real
  // cost_usd for Inkling (cost is declared in its opencode.json), so
  // postprocess-costs needs --force to override it.
  // meta/muse-spark-1.1, OpenRouter 2026-07-16. $1.25/$4.25 per 1M; cache read
  // $0.15/1M. No cache-write premium listed → cacheWrite = input (inert).
  muse:         { input: 1.25e-6,   cachedInput: 0.15e-6,  cacheWrite: 1.25e-6,   output: 4.25e-6 },
  inkling:      { input: 3.74e-6,   cachedInput: 0.748e-6, cacheWrite: 3.74e-6,   output: 9.36e-6 },
};

/** By Harbor model ID (provider/name). Aliased to MODEL_PRICING entries. */
export const HARBOR_MODEL_PRICING: Record<string, string> = {
  'anthropic/claude-fable-5[1m]':      'fable-5',
  'anthropic/claude-fable-5':          'fable-5',
  'anthropic/claude-opus-4-8':         'opus48',
  'anthropic/claude-opus-4-7':         'opus47',
  'anthropic/claude-opus-4-6':         'opus',
  'anthropic/claude-opus-4-5':         'opus45',
  'anthropic/claude-sonnet-5':         'sonnet5',
  'anthropic/claude-sonnet-5-xhigh':   'sonnet5-xhigh',
  'anthropic/claude-sonnet-4-6':       'sonnet46',
  'anthropic/claude-sonnet-4-5':       'sonnet45',
  'anthropic/claude-haiku-4-5':        'haiku',
  'openai/gpt-5.2-codex':              'codex',
  'openai/gpt-5.3-codex':              'codex53',
  'openai/gpt-5.4':                    'gpt54',
  'openai/gpt-5.4-mini':               'gpt54mini',
  'openai/gpt-5.4-nano':               'gpt54nano',
  'openai/gpt-5.5':                    'gpt55',
  'openai/gpt-5.6-sol':                'gpt56',
  'openai/gpt-5.6':                    'gpt56', // alias — routes to Sol
  'openai/gpt-5.6-luna':               'gpt56luna',
  'google/gemini-3-pro-preview':       'gemini',
  'google/gemini-3.1-pro-preview':     'gemini31',
  'google/gemini-3-flash-preview':     'geminiflash',
  'google/gemini-3.5-flash':           'gemini35flash',
  'gemini/gemini-3-pro-preview':       'gemini',
  'gemini/gemini-3.1-pro-preview':     'gemini31',
  'gemini/gemini-3-flash-preview':     'geminiflash',
  'gemini/gemini-3.5-flash':           'gemini35flash',
  'openrouter/z-ai/glm-5':             'glm',
  'openrouter/z-ai/glm-5.2':           'glm52',
  'openrouter/moonshotai/kimi-k2.5':   'kimi',
  'openrouter/qwen/qwen3.5-35b-a3b':   'qwen35',
  'openrouter/qwen/qwen3-max':         'qwen3max',
  'openrouter/qwen/qwen3.7-max':       'qwen37max',
  'openrouter/deepseek/deepseek-v4-pro': 'deepseek',
  'openrouter/moonshotai/kimi-k2.6':   'kimi26',
  'openrouter/moonshotai/kimi-k2.7-code': 'kimi27',
  'openrouter/moonshotai/kimi-k3':     'kimi3',
  'openrouter/x-ai/grok-4.5':          'grok45',
  'openrouter/x-ai/grok-4.3':          'grok43',
  'openrouter/meta/muse-spark-1.1':    'muse',
  'tinker/thinkingmachines/Inkling:peft:262144': 'inkling',
};

/** Look up pricing by either internal label or Harbor model ID. */
export function getPricing(modelKey: string): ModelPricing | null {
  if (MODEL_PRICING[modelKey]) return MODEL_PRICING[modelKey];
  const alias = HARBOR_MODEL_PRICING[modelKey];
  if (alias && MODEL_PRICING[alias]) return MODEL_PRICING[alias];
  return null;
}

/**
 * Compute USD cost from a token breakdown. Returns null if pricing unknown.
 *
 * Token conventions (as recorded by Harbor):
 *   - `inputTokens` (n_input_tokens) is the cache-INCLUSIVE prompt total, i.e.
 *     base input + cache READS. For Anthropic it EXCLUDES cache-creation tokens.
 *   - `cacheTokens` (n_cache_tokens) is cache READS only.
 *   - `cacheWriteTokens` (cache_creation_input_tokens) is billed ON TOP of
 *     inputTokens — Anthropic does not fold writes into n_input_tokens.
 */
export function computeCost(
  modelKey: string,
  inputTokens: number,
  cacheTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
): number | null {
  const p = getPricing(modelKey);
  if (!p) return null;
  if (p.input === 0 && p.output === 0) return null; // not yet priced
  const nonCached = Math.max(0, inputTokens - cacheTokens);
  return (
    nonCached * p.input +
    cacheTokens * p.cachedInput +
    cacheWriteTokens * p.cacheWrite +
    outputTokens * p.output
  );
}
