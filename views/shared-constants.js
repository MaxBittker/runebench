// Shared constants and helpers for RuneBench views
// Used by graph-skills.html and index.html (via cumulative-chart.js)

const VIEWS_BASE = window.VIEWS_BASE || '';

// releaseDate (YYYY-MM-DD) sourced from https://models.dev/. xhigh variants
// inherit their base model's date.
const MODEL_CONFIG = {
  'fable-5':   { displayName: 'Claude Fable 5',   shortName: 'Fable 5',    color: '#c2703e', order: 0.1, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-09' },
  'fable-5-xhigh': { displayName: 'Claude Fable 5 xhigh', shortName: 'Fable 5 xh', color: '#9c5226', order: 0.12, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2026-06-09' },
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
  'haiku':    { displayName: 'Claude Haiku 4.5',   shortName: 'Haiku 4.5',  color: '#e06090', order: 7, icon: VIEWS_BASE + 'model-icons/anthropic.svg', releaseDate: '2025-10-15' },
  'codex':    { displayName: 'Codex CLI 5.2',       shortName: 'Codex 5.2', color: '#10a37f', order: 8, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2025-12-11' },
  'codex53':  { displayName: 'Codex CLI 5.3',       shortName: 'Codex 5.3', color: '#0d8c6b', order: 9, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-02-05' },
  'gpt56':    { displayName: 'GPT-5.6 Sol',          shortName: 'GPT-5.6 Sol', color: '#044f36', order: 9.4, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56-xhigh': { displayName: 'GPT-5.6 Sol xhigh', shortName: 'GPT-5.6 Sol xh', color: '#022c1e', order: 9.42, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56luna': { displayName: 'GPT-5.6 Luna',        shortName: 'GPT-5.6 Luna', color: '#12a56f', order: 9.44, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt56luna-xhigh': { displayName: 'GPT-5.6 Luna xhigh', shortName: 'GPT-5.6 Luna xh', color: '#0b7a50', order: 9.46, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-07-09' },
  'gpt55':    { displayName: 'GPT-5.5',             shortName: 'GPT-5.5',  color: '#066f4a', order: 9.5, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-04-23' },
  'gpt55-apikey': { displayName: 'GPT-5.5 xhigh',  shortName: 'GPT-5.5 xh', color: '#02392a', order: 9.6, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-04-23' },
  'gpt54':    { displayName: 'GPT-5.4',             shortName: 'GPT-5.4',  color: '#0a7a5a', order: 10, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-05' },
  'gpt54mini': { displayName: 'GPT-5.4 Mini',     shortName: 'GPT-5.4 Mini', color: '#15b886', order: 10.5, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-17' },
  'gpt54nano': { displayName: 'GPT-5.4 Nano',     shortName: 'GPT-5.4 Nano', color: '#20d6a2', order: 10.6, icon: VIEWS_BASE + 'model-icons/openai.png', releaseDate: '2026-03-17' },
  'glm':      { displayName: 'GLM 5',             shortName: 'GLM 5',       color: '#6c5ce7', order: 11, icon: VIEWS_BASE + 'model-icons/zai.png', releaseDate: '2026-02-11' },
  'glm52':    { displayName: 'GLM 5.2',           shortName: 'GLM 5.2',     color: '#4834d4', order: 11.2, icon: VIEWS_BASE + 'model-icons/zai.png', releaseDate: '2026-06-16' },
  'kimi':     { displayName: 'Kimi K2.5',         shortName: 'Kimi K2.5',   color: '#00b4d8', order: 12, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-01-15' },
  'kimi26':   { displayName: 'Kimi K2.6',         shortName: 'Kimi K2.6',   color: '#0077b6', order: 12.5, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-04-21' },
  'kimi27':   { displayName: 'Kimi K2.7 Code',    shortName: 'Kimi K2.7',   color: '#023e8a', order: 12.6, icon: VIEWS_BASE + 'model-icons/kimi.png', releaseDate: '2026-06-12' },
  'deepseek': { displayName: 'DeepSeek V4 Pro',   shortName: 'DeepSeek V4', color: '#4d6bfe', order: 12.8, icon: VIEWS_BASE + 'model-icons/deepseek.png', releaseDate: '2026-04-24' },
  'qwen35':   { displayName: 'Qwen3.5 35B',     shortName: 'Qwen3.5 35B', color: '#818cf8', order: 14, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2026-02-16' },
  'qwen3max': { displayName: 'Qwen3 Max',       shortName: 'Qwen3 Max',   color: '#a5b4fc', order: 15, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2025-09-23' },
  'qwen37max': { displayName: 'Qwen3.7 Max',    shortName: 'Qwen3.7 Max', color: '#4f46e5', order: 15.5, icon: VIEWS_BASE + 'model-icons/qwen.webp', releaseDate: '2026-05-21' },
  'grok45':   { displayName: 'Grok 4.5',        shortName: 'Grok 4.5',    color: '#1c1c1c', order: 16, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-07-08' },
  'grok45-xhigh': { displayName: 'Grok 4.5 xhigh', shortName: 'Grok 4.5 xh', color: '#555555', order: 16.1, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-07-08' },
  'grok43':   { displayName: 'Grok 4.3',        shortName: 'Grok 4.3',    color: '#8a8a8a', order: 16.2, icon: VIEWS_BASE + 'model-icons/xai.svg', releaseDate: '2026-04-17' },
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
        const rate = (deltaXp / deltaMs) * 60000 / 8 / 25; // real-game XP/min
        if (rate > peakRate) peakRate = rate;
      }
    }

    points.push({ x, y: Math.round(peakRate) });
  }

  return points;
}
