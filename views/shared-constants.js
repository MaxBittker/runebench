// Shared constants and helpers for RuneBench views
// Used by graph-skills.html and index.html (via cumulative-chart.js)

const VIEWS_BASE = window.VIEWS_BASE || '';

// XP score normalization: raw server XP ÷ 8 (game speed) ÷ 25 (server xpRate) = real-game XP.
// scripts/check-xp-normalization-sync.ts guards this against drift.
const XP_NORMALIZATION_DIVISOR = 8 * 25;

// releaseDate (YYYY-MM-DD) sourced from https://models.dev/. xhigh variants
// inherit their base model's date.
const MODEL_CONFIG = {
  // Both fable rows are the 2026-07-20 runs on image v53. The June runs (image v40,
  // pre-÷200 task prompt) are archived under jobs/_archive-v40-fable.
  'fable-5':   { displayName: 'Claude Fable 5',   shortName: 'Fable 5',    color: '#c2703e', order: 0.1, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-09' },
  'fable-5-xhigh': { displayName: 'Claude Fable 5 xhigh', shortName: 'Fable 5 xh', color: '#9c5226', order: 0.12, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-09' },
  'opus5-fast': { displayName: 'Claude Opus 5 fast', shortName: 'Opus 5 fast', color: '#5c4020', order: 0.24, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-07-24' },
  'opus5':    { displayName: 'Claude Opus 5',     shortName: 'Opus 5',      color: '#8a6a3f', order: 0.26, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-07-24' },
  'opus5-xhigh': { displayName: 'Claude Opus 5 xhigh', shortName: 'Opus 5 xh', color: '#7a4a2b', order: 0.27, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-07-24' },
  'opus5-medium': { displayName: 'Claude Opus 5 medium', shortName: 'Opus 5 med', color: '#c9714b', order: 0.28, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-07-24' },
  'opus5-low': { displayName: 'Claude Opus 5 low', shortName: 'Opus 5 lo', color: '#c78d5e', order: 0.29, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-07-24' },
  'opus48':   { displayName: 'Claude Opus 4.8',   shortName: 'Opus 4.8',    color: '#7a6045', order: 0.3, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-05-28' },
  'opus48-max': { displayName: 'Claude Opus 4.8 max', shortName: 'Opus 4.8 max', color: '#2e1f10', order: 0.35, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-05-28' },
  'opus47':   { displayName: 'Claude Opus 4.7',   shortName: 'Opus 4.7',    color: '#6d5843', order: 0.5, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-04-16' },
  'opus47-xhigh': { displayName: 'Claude Opus 4.7 xhigh', shortName: 'Opus 4.7 xh', color: '#4a3320', order: 0.55, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-04-16' },
  'opus':     { displayName: 'Claude Opus 4.6',   shortName: 'Opus 4.6',    color: '#8b7355', order: 1, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-03-13' },
  'opus45':   { displayName: 'Claude Opus 4.5',   shortName: 'Opus 4.5',    color: '#a08060', order: 2, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2025-11-24' },
  'sonnet5':  { displayName: 'Claude Sonnet 5',   shortName: 'Sonnet 5',    color: '#b91c1c', order: 2.7, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-30' },
  'sonnet5-xhigh': { displayName: 'Claude Sonnet 5 xhigh', shortName: 'Sonnet 5 xh', color: '#7f1010', order: 2.75, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-30' },
  'sonnet46': { displayName: 'Claude Sonnet 4.6', shortName: 'Sonnet 4.6',  color: '#d4442a', order: 3, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-03-13' },
  'sonnet45': { displayName: 'Claude Sonnet 4.5', shortName: 'Sonnet 4.5',  color: '#e07850', order: 4, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2025-09-29' },
  'gemini':   { displayName: 'Gemini 3 Pro',      shortName: 'Gemini 3 Pro',    color: '#4285f4', order: 5, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2025-11-18' },
  'gemini31': { displayName: 'Gemini 3.1 Pro',    shortName: 'Gemini 3.1 Pro',  color: '#1a57c4', order: 6, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-02-19' },
  'geminiflash': { displayName: 'Gemini 3 Flash', shortName: 'Gemini 3 Flash', color: '#7baaf7', order: 6.5, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2025-12-17' },
  'gemini35flash': { displayName: 'Gemini 3.5 Flash', shortName: 'Gemini 3.5 Flash', color: '#5295e8', order: 6.6, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-05-19' },
  'gemini35flash-high': { displayName: 'Gemini 3.5 Flash high', shortName: 'Gemini 3.5 Flash hi', color: '#1f6fd0', order: 6.65, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-05-19' },
  'gemini36flash': { displayName: 'Gemini 3.6 Flash', shortName: 'Gemini 3.6 Flash', color: '#2d6bdf', order: 6.67, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-07-21' },
  'gemini35flashlite': { displayName: 'Gemini 3.5 Flash-Lite', shortName: 'Gemini 3.5 F-Lite', color: '#9dc0f9', order: 6.68, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-07-21' },
  'haiku':    { displayName: 'Claude Haiku 4.5',   shortName: 'Haiku 4.5',  color: '#e06090', order: 7, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2025-10-15' },
  'codex':    { displayName: 'Codex CLI 5.2',       shortName: 'Codex 5.2', color: '#10a37f', order: 8, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2025-12-11' },
  'codex53':  { displayName: 'Codex CLI 5.3',       shortName: 'Codex 5.3', color: '#0d8c6b', order: 9, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-02-05' },
  'gpt56':    { displayName: 'GPT-5.6 Sol',          shortName: 'GPT-5.6 Sol', color: '#044f36', order: 9.4, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56-xhigh': { displayName: 'GPT-5.6 Sol xhigh', shortName: 'GPT-5.6 Sol xh', color: '#022c1e', order: 9.42, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56-fast': { displayName: 'GPT-5.6 Sol fast',   shortName: 'GPT-5.6 Sol fast', color: '#2f7f63', order: 9.425, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56terra': { displayName: 'GPT-5.6 Terra',      shortName: 'GPT-5.6 Terra', color: '#0c8a5b', order: 9.43, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56terra-xhigh': { displayName: 'GPT-5.6 Terra xhigh', shortName: 'GPT-5.6 Terra xh', color: '#06603d', order: 9.435, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56terra-fast': { displayName: 'GPT-5.6 Terra fast', shortName: 'GPT-5.6 Terra fast', color: '#3f9b78', order: 9.437, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56luna': { displayName: 'GPT-5.6 Luna',        shortName: 'GPT-5.6 Luna', color: '#12a56f', order: 9.44, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56luna-xhigh': { displayName: 'GPT-5.6 Luna xhigh', shortName: 'GPT-5.6 Luna xh', color: '#0b7a50', order: 9.46, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56luna-fast': { displayName: 'GPT-5.6 Luna fast', shortName: 'GPT-5.6 Luna fast', color: '#56c496', order: 9.47, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt55':    { displayName: 'GPT-5.5',             shortName: 'GPT-5.5',  color: '#066f4a', order: 9.5, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-04-23' },
  'gpt55-apikey': { displayName: 'GPT-5.5 xhigh',  shortName: 'GPT-5.5 xh', color: '#02392a', order: 9.6, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-04-23' },
  'gpt54':    { displayName: 'GPT-5.4',             shortName: 'GPT-5.4',  color: '#0a7a5a', order: 10, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-05' },
  'gpt54mini': { displayName: 'GPT-5.4 Mini',     shortName: 'GPT-5.4 Mini', color: '#15b886', order: 10.5, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-17' },
  'gpt54nano': { displayName: 'GPT-5.4 Nano',     shortName: 'GPT-5.4 Nano', color: '#20d6a2', order: 10.6, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-17' },
  'glm':      { displayName: 'GLM 5',             shortName: 'GLM 5',       color: '#6c5ce7', order: 11, icon: VIEWS_BASE + 'model-icons/zai.png', releaseDate: '2026-02-11' },
  'glm52':    { displayName: 'GLM 5.2',           shortName: 'GLM 5.2',     color: '#4834d4', order: 11.2, icon: VIEWS_BASE + 'model-icons/zai.png', releaseDate: '2026-06-16' },
  'glm52-wandb': { displayName: 'GLM 5.2 (WandB fp4)', shortName: 'GLM 5.2 fp4', color: '#2d1fa0', order: 11.25, icon: VIEWS_BASE + 'model-icons/zai.png', releaseDate: '2026-06-16' },
  'gemma4':   { displayName: 'Gemma 4 31B',       shortName: 'Gemma 4 31B', color: '#9b72cb', order: 6.8, icon: VIEWS_BASE + 'model-icons/gemini.webp', releaseDate: '2026-04-02' },
  'gptoss120b': { displayName: 'GPT-OSS-120B',    shortName: 'GPT-OSS-120B', color: '#33c79e', order: 10.8, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2025-08-05' },
  'kimi':     { displayName: 'Kimi K2.5',         shortName: 'Kimi K2.5',   color: '#00b4d8', order: 12, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-01-15' },
  'kimi26':   { displayName: 'Kimi K2.6',         shortName: 'Kimi K2.6',   color: '#0077b6', order: 12.5, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-04-21' },
  'kimi27':   { displayName: 'Kimi K2.7 Code',    shortName: 'Kimi K2.7',   color: '#023e8a', order: 12.6, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-06-12' },
  'kimi3':    { displayName: 'Kimi K3',           shortName: 'Kimi K3',     color: '#03045e', order: 12.7, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-07-16' },
  'deepseek': { displayName: 'DeepSeek V4 Pro',   shortName: 'DeepSeek V4', color: '#4d6bfe', order: 12.8, icon: VIEWS_BASE + 'model-icons/deepseek.png', releaseDate: '2026-04-24' },
  'deepseekflash': { displayName: 'DeepSeek V4 Flash', shortName: 'DS V4 Flash', color: '#8fa3ff', order: 12.85, icon: VIEWS_BASE + 'model-icons/deepseek.png', releaseDate: '2026-04-24' },
  'qwen35':   { displayName: 'Qwen3.5 35B',     shortName: 'Qwen3.5 35B', color: '#818cf8', order: 14, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2026-02-16' },
  'qwen3max': { displayName: 'Qwen3 Max',       shortName: 'Qwen3 Max',   color: '#a5b4fc', order: 15, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2025-09-23' },
  'qwen37max': { displayName: 'Qwen3.7 Max',    shortName: 'Qwen3.7 Max', color: '#4f46e5', order: 15.5, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2026-05-21' },
  'grok45':   { displayName: 'Grok 4.5',        shortName: 'Grok 4.5',    color: '#1c1c1c', order: 16, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-07-08' },
  'grok45-medium': { displayName: 'Grok 4.5 medium', shortName: 'Grok 4.5 med', color: '#555555', order: 16.1, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-07-08' },
  'grok43':   { displayName: 'Grok 4.3',        shortName: 'Grok 4.3',    color: '#8a8a8a', order: 16.2, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-04-17' },
  'muse':     { displayName: 'Muse Spark 1.1',  shortName: 'Muse Spark',  color: '#0064e0', order: 18, icon: VIEWS_BASE + 'model-icons/meta.svg', releaseDate: '2026-07-09' },
  'inkling':  { displayName: 'Inkling',         shortName: 'Inkling',     color: '#343a40', order: 17, icon: VIEWS_BASE + 'model-icons/thinkingmachines.png', releaseDate: '2026-07-15' },
  'laguna':   { displayName: 'Laguna S 2.1',    shortName: 'Laguna S',    color: '#0891b2', order: 19, icon: VIEWS_BASE + 'model-icons/poolside.png', releaseDate: '2026-07-20' },
};

const SKILL_ORDER = [
  'attack', 'defence', 'strength', 'hitpoints',
  'ranged', 'prayer', 'magic', 'woodcutting',
  'fishing', 'mining', 'cooking', 'fletching',
  'crafting', 'smithing', 'firemaking', 'thieving',
];

const SKILL_DISPLAY = {
  attack: 'Attack', defence: 'Defence', strength: 'Strength', hitpoints: 'Hitpoints',
  ranged: 'Ranged', prayer: 'Prayer', magic: 'Magic', woodcutting: 'Woodcutting',
  fishing: 'Fishing', mining: 'Mining', cooking: 'Cooking', fletching: 'Fletching',
  crafting: 'Crafting', smithing: 'Smithing', firemaking: 'Firemaking', thieving: 'Thieving',
};

function formatXp(xp) {
  if (xp >= 1_000_000) return (xp / 1_000_000).toFixed(1) + 'M';
  if (xp >= 1_000) return (xp / 1_000).toFixed(1) + 'k';
  return String(xp);
}

function formatRate(rate) {
  if (rate >= 1000) return (rate / 1000).toFixed(1) + 'k/min';
  if (rate >= 1) return Math.round(rate) + '/min';
  if (rate > 0) return rate.toFixed(1) + '/min';
  return '0/min';
}

function sanitizePoints(points) {
  if (points.length < 3) return points;
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const prev = i > 0 ? points[i - 1].y : 0;
    const next = i < points.length - 1 ? points[i + 1].y : points[i].y;
    if (points[i].y === 0 && prev > 0 && next > 0) continue;
    result.push(points[i]);
  }
  return result;
}

/** Extract raw XP points over time for a skill (used by trajectory views) */
function extractSkillPoints(skillData, skill, horizonMinutes) {
  if (!skillData || !skillData.samples || skillData.samples.length === 0) return [];
  const skillNameCaps = SKILL_DISPLAY[skill] || skill;

  const points = [];
  for (const s of skillData.samples) {
    const x = s.elapsedMs / 60000;
    if (x > horizonMinutes) break;
    let xp = 0;
    if (s.skills) {
      for (const [sName, sData] of Object.entries(s.skills)) {
        if (sName.toLowerCase() === skillNameCaps.toLowerCase() ||
            sName.toLowerCase() === skill.toLowerCase()) {
          xp = sData.xp || 0;
          break;
        }
      }
    }
    points.push({ x, y: xp });
  }

  return sanitizePoints(points);
}

/**
 * Extract peak XP rate (XP/min) over time for a skill.
 * Returns monotonically increasing points: at each sample, the running max of
 * per-window XP rates seen so far.
 */
function extractPeakRatePoints(skillData, skill, horizonMinutes) {
  if (!skillData || !skillData.samples || skillData.samples.length < 2) return [];
  const skillNameCaps = SKILL_DISPLAY[skill] || skill;

  function getXp(sample) {
    if (!sample.skills) return 0;
    for (const [sName, sData] of Object.entries(sample.skills)) {
      if (sName.toLowerCase() === skillNameCaps.toLowerCase() ||
          sName.toLowerCase() === skill.toLowerCase()) {
        return sData.xp || 0;
      }
    }
    return 0;
  }

  let peakRate = 0;
  const points = [];
  const samples = skillData.samples;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const x = s.elapsedMs / 60000;
    if (x > horizonMinutes) break;

    if (i > 0) {
      const prev = samples[i - 1];
      const deltaXp = getXp(s) - getXp(prev);
      const deltaMs = s.elapsedMs - prev.elapsedMs;
      if (deltaMs > 0 && deltaXp > 0) {
        const rate = (deltaXp / deltaMs) * 60000 / XP_NORMALIZATION_DIVISOR; // real-game XP/min
        if (rate > peakRate) peakRate = rate;
      }
    }

    points.push({ x, y: Math.round(peakRate) });
  }

  return points;
}
