// Shared constants and helpers for RuneBench views
// Used by graph-skills.html and index.html (via cumulative-chart.js)

const VIEWS_BASE = window.VIEWS_BASE || '';

const MODEL_CONFIG = {
  'opus':     { displayName: 'Claude Opus 4.6',   shortName: 'Opus 4.6',    color: '#8b7355', order: 1, icon: VIEWS_BASE + 'model-icons/anthropic.svg' },
  'opus45':   { displayName: 'Claude Opus 4.5',   shortName: 'Opus 4.5',    color: '#a08060', order: 2, icon: VIEWS_BASE + 'model-icons/anthropic.svg' },
  'sonnet46': { displayName: 'Claude Sonnet 4.6', shortName: 'Sonnet 4.6',  color: '#d4442a', order: 3, icon: VIEWS_BASE + 'model-icons/anthropic.svg' },
  'sonnet45': { displayName: 'Claude Sonnet 4.5', shortName: 'Sonnet 4.5',  color: '#e07850', order: 4, icon: VIEWS_BASE + 'model-icons/anthropic.svg' },
  'gemini':   { displayName: 'Gemini 3 Pro',      shortName: 'Gemini 3',    color: '#4285f4', order: 5, icon: VIEWS_BASE + 'model-icons/gemini.webp' },
  'gemini31': { displayName: 'Gemini 3.1 Pro',    shortName: 'Gemini 3.1',  color: '#1a57c4', order: 6, icon: VIEWS_BASE + 'model-icons/gemini.webp' },
  'geminiflash': { displayName: 'Gemini 3 Flash', shortName: 'Gemini Flash', color: '#7baaf7', order: 6.5, icon: VIEWS_BASE + 'model-icons/gemini.webp' },
  'haiku':    { displayName: 'Claude Haiku 3.5',   shortName: 'Haiku 3.5',  color: '#e06090', order: 7, icon: VIEWS_BASE + 'model-icons/anthropic.svg' },
  'codex':    { displayName: 'Codex CLI 5.2',       shortName: 'Codex 5.2', color: '#10a37f', order: 8, icon: VIEWS_BASE + 'model-icons/openai.png' },
  'codex53':  { displayName: 'Codex CLI 5.3',       shortName: 'Codex 5.3', color: '#0d8c6b', order: 9, icon: VIEWS_BASE + 'model-icons/openai.png' },
  'gpt54':    { displayName: 'GPT-5.4',             shortName: 'GPT-5.4',  color: '#0a7a5a', order: 10, icon: VIEWS_BASE + 'model-icons/openai.png' },
  'glm':      { displayName: 'GLM 5',             shortName: 'GLM 5',       color: '#6c5ce7', order: 11, icon: VIEWS_BASE + 'model-icons/zai.png' },
  'kimi':     { displayName: 'Kimi K2.5',         shortName: 'Kimi K2.5',   color: '#00b4d8', order: 12, icon: VIEWS_BASE + 'model-icons/kimi.png' },
  'qwen3':    { displayName: 'Qwen3 Coder Next', shortName: 'Qwen3 Coder',  color: '#6366f1', order: 13, icon: VIEWS_BASE + 'model-icons/qwen.webp' },
  'qwen35':   { displayName: 'Qwen3.5 35B',     shortName: 'Qwen3.5 35B', color: '#818cf8', order: 14, icon: VIEWS_BASE + 'model-icons/qwen.webp' },
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
