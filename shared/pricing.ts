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
  // Opus 5, launched 2026-07-24: standard $5/$25 (same rate card as 4.8).
  // Fast mode (2.5x speed) is 2x base: $10/$50; cache multipliers apply on the
  // fast rates (read 0.1x, 5-min write 1.25x). Fast runs share the harbor model
  // id 'anthropic/claude-opus-5' with standard runs — postprocess-costs keys
  // the fast row off the '-opus5-fast-' job-dir token instead.
  // cost_usd is baked into jobs/: -low/-xhigh at the correct 2×
  // rate; base/-medium at 1.25× (~12% cache-write undercount).
  opus5:        { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 25e-6 },
  // opus5-fast ran via subscription OAuth (run-claude-oauth-30m.sh + CLAUDE_FAST=1),
  // which writes the 1h cache bucket → cacheWrite = 2× fast input, not 5-min 1.25×.
  'opus5-fast': { input: 10e-6,   cachedInput: 1e-6,     cacheWrite: 20e-6,    output: 50e-6 },
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
  // gpt-5.6 family, released 2026-07-09. Sol matches gpt-5.5's $5/$30 rate card.
  // 2026-07-30 price cut (openai.com/index/advancing-the-price-performance-
  // frontier-with-gpt-5-6): Terra $2.50/$15 → $2/$12, Luna $1/$6 → $0.20/$1.20;
  // Sol unchanged. Pre-cut runs were --force-backfilled to the NEW rates on
  // 2026-07-30 (leaderboard shows current replication cost, not historical). 5.6
  // introduces a 1.25× cache-write premium (inert unless usage reports a write
  // bucket). xhigh variants share the base rate card — higher effort just
  // emits more reasoning tokens (billed as output).
  gpt56:        { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 30e-6 },
  'gpt56-xhigh': { input: 5e-6,   cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,  output: 30e-6 },
  gpt56terra:   { input: 2e-6,    cachedInput: 0.2e-6,   cacheWrite: 2.5e-6,   output: 12e-6 },
  'gpt56terra-xhigh': { input: 2e-6, cachedInput: 0.2e-6, cacheWrite: 2.5e-6, output: 12e-6 },
  gpt56luna:    { input: 0.2e-6,  cachedInput: 0.02e-6,  cacheWrite: 0.25e-6,  output: 1.2e-6 },
  'gpt56luna-xhigh': { input: 0.2e-6, cachedInput: 0.02e-6, cacheWrite: 0.25e-6, output: 1.2e-6 },
  // Fast rows: codex `service_tier = "fast"`, which goes out as the API's
  // "priority" tier. Priority serving bills 2.5x the standard rate card (vs
  // opus5-fast's 2x). The family's 1.25x cache-write premium and 0.1x cache
  // read apply on the FAST rates, not the base ones.
  // These share a harbor model id with their base row, so postprocess-costs
  // keys them off the '-gpt56*-fast-' job-dir token — same trick as opus5-fast.
  // cost_usd is cached in jobs/, so changing these needs:
  //   bun scripts/postprocess-costs.ts --force --models gpt56-fast,gpt56terra-fast,gpt56luna-fast
  'gpt56-fast':      { input: 12.5e-6, cachedInput: 1.25e-6,  cacheWrite: 15.625e-6, output: 75e-6 },
  'gpt56terra-fast': { input: 5e-6,    cachedInput: 0.5e-6,   cacheWrite: 6.25e-6,   output: 30e-6 },
  'gpt56luna-fast':  { input: 0.5e-6,  cachedInput: 0.05e-6,  cacheWrite: 0.625e-6,  output: 3e-6 },
  gemini:       { input: 2e-6,    cachedInput: 0.2e-6,   cacheWrite: 2e-6,     output: 12e-6 },
  gemini31:     { input: 2e-6,    cachedInput: 0.2e-6,   cacheWrite: 2e-6,     output: 12e-6 },
  geminiflash:  { input: 0.5e-6,  cachedInput: 0.05e-6,  cacheWrite: 0.5e-6,   output: 3e-6 },
  gemini35flash:{ input: 1.5e-6,  cachedInput: 0.15e-6,  cacheWrite: 1.5e-6,   output: 9e-6 },
  // Same per-token rates as gemini35flash — thinking_level=high just emits more
  // thinking tokens (billed as output), it doesn't change the rate card.
  'gemini35flash-high': { input: 1.5e-6, cachedInput: 0.15e-6, cacheWrite: 1.5e-6, output: 9e-6 },
  // gemini-3.6-flash / gemini-3.5-flash-lite, launched 2026-07-21 (Google blog +
  // models.dev). 3.6 keeps 3.5 Flash's input rate but drops output $9 → $7.50.
  // Run via OpenCode (google provider) which reports native cost_usd from the
  // same models.dev rates — these entries are for display/backfill parity only.
  gemini36flash:     { input: 1.5e-6, cachedInput: 0.15e-6, cacheWrite: 1.5e-6, output: 7.5e-6 },
  // gemini-3.7-flash, launched 2026-08-13. Introductory rates ($0.75/$3.75 per
  // 1M, cache read 10% of input) good through 2026-12-31; standard rates from
  // 2027-01-01 are $1.50/$7.50 — bump this entry then.
  gemini37flash:     { input: 0.75e-6, cachedInput: 0.075e-6, cacheWrite: 0.75e-6, output: 3.75e-6 },
  gemini35flashlite: { input: 0.3e-6, cachedInput: 0.03e-6, cacheWrite: 0.3e-6, output: 2.5e-6 },
  glm:          { input: 0.72e-6,   cachedInput: 0,        cacheWrite: 0.72e-6,   output: 2.3e-6 },
  glm52:        { input: 1.4e-6,    cachedInput: 0,        cacheWrite: 1.4e-6,    output: 4.4e-6 }, // z-ai/glm-5.2, OpenRouter 2026-06-16
  // z-ai/glm-5.2 pinned to the WandB fp4 endpoint, OpenRouter 2026-07-17.
  // Native OpenCode cost is accurate (rates declared in glm52wandb_adapter.py).
  'glm52-wandb': { input: 1.39e-6,  cachedInput: 0.26e-6,  cacheWrite: 1.39e-6,   output: 4.4e-6 },
  // google/gemma-4-31b-it pinned to Cerebras fp16, OpenRouter 2026-07-17 (cache read = full
  // input price). Friendli was the original pick but its endpoint rejects tool calls.
  gemma4:       { input: 0.99e-6,   cachedInput: 0.99e-6,  cacheWrite: 0.99e-6,   output: 1.49e-6 },
  // openai/gpt-oss-120b pinned to Cerebras fp16, OpenRouter 2026-07-17 (cache read = full input price).
  gptoss120b:   { input: 0.35e-6,   cachedInput: 0.35e-6,  cacheWrite: 0.35e-6,   output: 0.75e-6 },
  kimi:         { input: 0.6e-6,    cachedInput: 0.1e-6,   cacheWrite: 0.6e-6,    output: 3e-6 },
  qwen35:       { input: 0.1625e-6, cachedInput: 0,        cacheWrite: 0.1625e-6, output: 1.3e-6 },
  qwen3max:     { input: 0.78e-6,   cachedInput: 0,        cacheWrite: 0.78e-6,   output: 3.9e-6 },
  // OpenRouter listed rates as of 2026-06-09.
  // qwen3.7-max: Alibaba bills cache writes at 1.25× input (like Anthropic).
  qwen37max:    { input: 1.25e-6,   cachedInput: 0.25e-6,  cacheWrite: 1.5625e-6, output: 3.75e-6 },
  // qwen/qwen3.8-max, OpenRouter (Alibaba, sole provider) 2026-08-12.
  // $2/$6 per 1M; cache read $0.25/1M, cache write $2.50/1M (1.25× input).
  qwen38max:    { input: 2e-6,       cachedInput: 0.25e-6,  cacheWrite: 2.5e-6,    output: 6e-6 },
  deepseek:     { input: 0.435e-6,  cachedInput: 0.003625e-6, cacheWrite: 0.435e-6, output: 0.87e-6 }, // deepseek-v4-pro
  // deepseek-v4-flash, OpenRouter 2026-07-21. No cache-write premium → cacheWrite = input (inert).
  deepseekflash: { input: 0.0938e-6, cachedInput: 0.01876e-6, cacheWrite: 0.0938e-6, output: 0.1876e-6 },
  // deepseek-v4-flash-0731 pinned to DeepInfra fp4, OpenRouter 2026-08-03 ($0.09/$0.18
  // per 1M, cache read $0.018). No cache-write premium → cacheWrite = input (inert).
  // Keep in sync with the per-1M `cost` block in agents/deepseek_adapter.py (cost
  // declared in opencode.json → OpenCode reports real cost_usd; postprocess-costs
  // needs --force to override it).
  deepseekflash0731: { input: 0.09e-6, cachedInput: 0.018e-6, cacheWrite: 0.09e-6, output: 0.18e-6 },
  kimi26:       { input: 0.68e-6,   cachedInput: 0.34e-6,  cacheWrite: 0.68e-6,   output: 3.41e-6 },
  kimi27:       { input: 0.75e-6,   cachedInput: 0.16e-6,  cacheWrite: 0.75e-6,   output: 3.5e-6 }, // kimi-k2.7-code, OpenRouter 2026-06-14
  kimi3:        { input: 3e-6,      cachedInput: 0.3e-6,   cacheWrite: 3e-6,      output: 15e-6 }, // kimi-k3, OpenRouter 2026-07-16 (no cache-write premium listed)
  // x-ai/grok-4.6, OpenRouter 2026-08-12. ≤200k-context rates ($2/$6 per 1M,
  // cache read $0.50/1M); xAI doubles rates past 200k input. No cache-write
  // premium listed → cacheWrite = input (inert).
  grok46:       { input: 2e-6,      cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // Same rate card — effort only changes how many reasoning tokens are emitted.
  'grok46-medium': { input: 2e-6,   cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  'grok46-xhigh':  { input: 2e-6,   cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // x-ai/grok-4.5, OpenRouter 2026-07-09. ≤200k-context rates; xAI doubles
  // rates past 200k input but our runs stay well under that.
  grok45:       { input: 2e-6,      cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // x-ai/grok-4.6, OpenRouter 2026-08-14 — same rate card as grok-4.5.
  grok46:       { input: 2e-6,      cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // Same rate card — medium effort just emits fewer reasoning tokens (billed as output).
  'grok45-medium': { input: 2e-6,   cachedInput: 0.5e-6,   cacheWrite: 2e-6,      output: 6e-6 },
  // x-ai/grok-4.3, OpenRouter/models.dev 2026-07-09. ≤200k-context rates (2× past 200k).
  grok43:       { input: 1.25e-6,   cachedInput: 0.2e-6,   cacheWrite: 1.25e-6,   output: 2.5e-6 },
  // muse-spark-1.1 via the Meta Model API direct (api.meta.ai), standard tier.
  // $1.25/$4.25 per 1M; cache read $0.15/1M — same rate card as the retired
  // OpenRouter route (original 2026-07-16 row; jobs archived under
  // jobs/_archive-muse-openrouter-20260813, replaced by the 2026-08-12 Meta-API
  // run). No cache-write premium listed → cacheWrite = input (inert).
  muse:         { input: 1.25e-6,   cachedInput: 0.15e-6,  cacheWrite: 1.25e-6,   output: 4.25e-6 },
  // muse-spark-1.2-contributor via the Meta Model API direct (api.meta.ai),
  // 2026-08-12. Displayed at muse-spark-1.2 STANDARD list price ($1.25/$4.25
  // per 1M, cache read $0.15 — same card as 1.1) by decision: the contributor
  // tier's ~95% data-for-training discount ($0.10/$0.20, cache read $0.002)
  // is what the API actually bills, but it isn't comparable to the other
  // rows' list prices. No cache-write premium → cacheWrite = input (inert).
  // Keep in sync with the per-1M `cost` block in agents/muse_adapter.py
  // (declared in opencode.json → OpenCode reports standard-rate cost_usd
  // natively for future runs; the 2026-08-12 job was repriced in place).
  muse12:       { input: 1.25e-6,   cachedInput: 0.15e-6,  cacheWrite: 1.25e-6,   output: 4.25e-6 },
  // thinkingmachines/inkling, OpenRouter (Together endpoint, the model's only
  // provider) 2026-07-21. No cache-write premium → cacheWrite = input (inert).
  // Keep in sync with the per-1M `cost` block in agents/inkling_adapter.py —
  // cost is declared in opencode.json, so OpenCode reports real cost_usd and
  // postprocess-costs needs --force to override it. (Earlier Tinker-direct runs
  // at $3.74/$9.36 were deleted and re-benchmarked on OpenRouter.)
  inkling:      { input: 1.0e-6,    cachedInput: 0.17e-6,  cacheWrite: 1.0e-6,    output: 4.05e-6 },
  // poolside/laguna-s-2.1, OpenRouter (Poolside bf16, the model's only provider)
  // 2026-07-22. $0.10/$0.20 per 1M; cache read $0.01/1M. No cache-write premium
  // → cacheWrite = input (inert). Keep in sync with the per-1M `cost` block in
  // agents/laguna_adapter.py (cost declared in opencode.json → OpenCode reports
  // real cost_usd; postprocess-costs needs --force to override it).
  laguna:       { input: 0.1e-6,    cachedInput: 0.01e-6,  cacheWrite: 0.1e-6,    output: 0.2e-6 },
};

/** By Harbor model ID (provider/name). Aliased to MODEL_PRICING entries. */
export const HARBOR_MODEL_PRICING: Record<string, string> = {
  'anthropic/claude-fable-5[1m]':      'fable-5',
  'anthropic/claude-fable-5':          'fable-5',
  // NOTE: opus5-fast shares this model id — postprocess-costs overrides the
  // pricing key from the job-dir name for '-opus5-fast-' runs.
  'anthropic/claude-opus-5':           'opus5',
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
  'openai/gpt-5.6-terra':              'gpt56terra',
  'openai/gpt-5.6-luna':               'gpt56luna',
  'google/gemini-3-pro-preview':       'gemini',
  'google/gemini-3.1-pro-preview':     'gemini31',
  'google/gemini-3-flash-preview':     'geminiflash',
  'google/gemini-3.5-flash':           'gemini35flash',
  'google/gemini-3.6-flash':           'gemini36flash',
  'google/gemini-3.7-flash':           'gemini37flash',
  'gemini/gemini-3.7-flash':           'gemini37flash',
  'openrouter/google/gemini-3.7-flash': 'gemini37flash',
  'google/gemini-3.5-flash-lite':      'gemini35flashlite',
  'gemini/gemini-3-pro-preview':       'gemini',
  'gemini/gemini-3.1-pro-preview':     'gemini31',
  'gemini/gemini-3-flash-preview':     'geminiflash',
  'gemini/gemini-3.5-flash':           'gemini35flash',
  'openrouter/z-ai/glm-5':             'glm',
  // NOTE: 'openrouter/z-ai/glm-5.2' maps to the z-ai-pinned baseline; the
  // glm52-wandb row shares the model ID so it can't be keyed here — its
  // adapter declares endpoint cost, so OpenCode-native cost_usd is correct.
  'openrouter/z-ai/glm-5.2':           'glm52',
  'openrouter/google/gemma-4-31b-it':  'gemma4',
  'openrouter/openai/gpt-oss-120b':    'gptoss120b',
  'openrouter/moonshotai/kimi-k2.5':   'kimi',
  'openrouter/qwen/qwen3.5-35b-a3b':   'qwen35',
  'openrouter/qwen/qwen3-max':         'qwen3max',
  'openrouter/qwen/qwen3.7-max':       'qwen37max',
  'openrouter/qwen/qwen3.8-max':       'qwen38max',
  'openrouter/deepseek/deepseek-v4-pro': 'deepseek',
  'openrouter/deepseek/deepseek-v4-flash': 'deepseekflash',
  'openrouter/~deepseek/deepseek-v4-flash-latest': 'deepseekflash',
  'openrouter/deepseek/deepseek-v4-flash-0731': 'deepseekflash0731',
  'openrouter/moonshotai/kimi-k2.6':   'kimi26',
  'openrouter/moonshotai/kimi-k2.7-code': 'kimi27',
  'openrouter/moonshotai/kimi-k3':     'kimi3',
  'openrouter/x-ai/grok-4.6':          'grok46',
  'openrouter/x-ai/grok-4.5':          'grok45',
  'openrouter/x-ai/grok-4.3':          'grok43',
  'openrouter/meta/muse-spark-1.1':    'muse',
  'meta/muse-spark-1.2-contributor':   'muse12',
  'meta/muse-spark-1.1':               'muse',
  'openrouter/thinkingmachines/inkling': 'inkling',
  'openrouter/poolside/laguna-s-2.1':  'laguna',
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
