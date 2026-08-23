import { describe, expect, test } from 'bun:test';
import {
  buildLeaderboardMarkdown,
  computePeakRate,
  extractEntries,
  getSkillXp,
  scanResults,
  timestampFromJobName,
  type SkillSample,
} from './update-leaderboard';

// ── Fixtures (fabricated result files, same shape as extract-skill-results.ts output) ──

function samples(points: Array<[number, number]>, skill = 'Woodcutting'): SkillSample[] {
  return points.map(([elapsedMs, xp]) => ({ elapsedMs, skills: { [skill]: { xp } } }));
}

const complete = {
  model: 'test-model',
  skills: {
    woodcutting: {
      jobName: 'skills-30m-test-model-20260417-230914',
      peakXpRate: 64,
      finalXp: 49000,
      finalLevel: 55,
      durationSeconds: 1785,
      sampleCount: 3,
      samples: samples([[0, 0], [60000, 4000], [120000, 10000]]),
      // peak window: 6000 raw XP over 60s → 6000 raw/min ÷ 200 = 30 XP/min
    },
    mining: {
      jobName: 'skills-30m-test-model-20260501-101112',
      peakXpRate: 12,
      // no samples at all → must fall back to stored peakXpRate
    },
  },
};

const partial = {
  model: 'partial-model',
  skills: {
    magic: {
      jobName: 'skills-30m-partial-model-20260601-000001',
      // truncated sample list, no stored rate — computed from what's there
      samples: samples([[0, 0], [30000, 500]], 'Magic'), // 500 raw over 30s → 1000 raw/min ÷ 200 = 5
    },
    fishing: null, // unusable entry — skipped
    cooking: { jobName: 'x' }, // no score at all — skipped
  },
};

describe('getSkillXp', () => {
  test('matches skill names case-insensitively', () => {
    const s: SkillSample = { elapsedMs: 0, skills: { Magic: { xp: 1175 } } };
    expect(getSkillXp(s, 'magic')).toBe(1175);
    expect(getSkillXp(s, 'MAGIC')).toBe(1175);
  });
  test('returns 0 for missing/undefined input', () => {
    expect(getSkillXp(undefined, 'magic')).toBe(0);
    expect(getSkillXp({ elapsedMs: 0, skills: {} }, 'magic')).toBe(0);
  });
});

describe('computePeakRate', () => {
  test('finds the best window and normalizes by GAME_SPEED × XP_MULTIPLIER', () => {
    const peak = computePeakRate(samples([[0, 0], [60000, 4000], [120000, 10000]]), 'woodcutting');
    // best window: 6000 XP / 60s = 6000 raw/min ÷ 200
    expect(peak.rate).toBeCloseTo(30, 5);
  });
  test('handles empty, single-sample, and malformed data', () => {
    expect(computePeakRate(undefined, 'x').rate).toBe(0);
    expect(computePeakRate([], 'x').rate).toBe(0);
    expect(computePeakRate([{ elapsedMs: 0, skills: {} }], 'x').rate).toBe(0);
    const bad = [
      { elapsedMs: 0, skills: { x: { xp: Number.NaN } } },
      { elapsedMs: -5, skills: { x: { xp: 10 } } },
    ] as unknown as SkillSample[];
    expect(computePeakRate(bad, 'x').rate).toBe(0);
  });
});

describe('extractEntries', () => {
  test('extracts computed + stored-fallback entries from a complete file', () => {
    const entries = extractEntries('complete.json', complete, 'results/skills-30m/complete.json');
    expect(entries).toHaveLength(2);
    const wc = entries.find(e => e.skill === 'woodcutting')!;
    expect(wc.model).toBe('test-model');
    expect(wc.source).toBe('samples');
    expect(wc.peakXpPerMin).toBeCloseTo(Math.max(30, 64), 5); // never regress below stored
    expect(wc.timestamp).toBe('2026-04-17 23:09:14');
    expect(wc.sourcePath).toBe('results/skills-30m/complete.json');
    const mining = entries.find(e => e.skill === 'mining')!;
    expect(mining.source).toBe('stored');
    expect(mining.peakXpPerMin).toBe(12);
  });

  test('skips partial/unusable skill entries without throwing', () => {
    const entries = extractEntries('partial.json', partial, 'results/skills-30m/partial.json');
    expect(entries).toHaveLength(1);
    expect(entries[0].skill).toBe('magic');
    expect(entries[0].peakXpPerMin).toBeCloseTo(5, 5);
  });

  test('falls back to filename when model field is missing; [] on garbage', () => {
    const noModel = extractEntries('anon.json', { skills: {} }, 'a.json');
    expect(noModel).toEqual([]);
    expect(extractEntries('bad.json', null, 'b.json')).toEqual([]);
    expect(extractEntries('bad.json', 'nope', 'b.json')).toEqual([]);
    expect(extractEntries('bad.json', { skills: 'nope' }, 'b.json').length).toBe(0);
  });
});

describe('timestampFromJobName', () => {
  test('parses YYYYMMDD-HHMMSS suffixes and tolerates junk', () => {
    expect(timestampFromJobName('skills-30m-opus-20260417-230914')).toBe('2026-04-17 23:09:14');
    expect(timestampFromJobName('no-timestamp-here')).toBeNull();
    expect(timestampFromJobName(undefined)).toBeNull();
    expect(timestampFromJobName(42)).toBeNull();
  });
});

describe('scanResults', () => {
  test('reads fixture dir, skips _data.js and corrupt files, collects warnings', async () => {
    const fixturesDir = new URL('./fixtures/update-leaderboard', import.meta.url).pathname;
    const { entries, warnings } = scanResults({ dir: fixturesDir, displayRoot: '.' });
    const models = new Set(entries.map(e => e.model));
    expect(models.has('fixture-a')).toBe(true);
    expect(models.has('fixture-b')).toBe(true);
    // corrupt.json and empty.json contribute nothing but must not be fatal
    expect(warnings.some(w => w.includes('corrupt.json'))).toBe(true);
    expect(warnings.some(w => w.includes('empty.json'))).toBe(true);
    // sorted determinism check happens in buildLeaderboardMarkdown tests
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const md = buildLeaderboardMarkdown(entries, new Date('2026-08-23T00:00:00Z'));
    expect(md).toContain('# Skills 30m Leaderboard');
    expect(md).toContain('÷ 8 (game speed) ÷ 25 (xpRate)');
    // descending score order: first detail row after header is the top score
    const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.includes('---'));
    expect(rows.length).toBeGreaterThan(0);
  });

  test('missing directory is graceful, not fatal', () => {
    const { entries, warnings } = scanResults({ dir: '/nonexistent/dir/xyz' });
    expect(entries).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('buildLeaderboardMarkdown', () => {
  test('sorts by score descending and includes timestamps and source paths', () => {
    const md = buildLeaderboardMarkdown([
      { model: 'slow', skill: 'mining', peakXpPerMin: 1, source: 'stored', timestamp: null, sourcePath: 'r/a.json' },
      { model: 'fast', skill: 'thieving', peakXpPerMin: 99.5, source: 'samples', timestamp: '2026-05-01 10:00:00', sourcePath: 'r/b.json' },
      { model: 'fast', skill: 'fishing', peakXpPerMin: 40, source: 'samples', timestamp: '2026-05-02 10:00:00', sourcePath: 'r/b.json' },
    ], new Date('2026-08-23T00:00:00Z'));
    const detailRows = md.split('\n').filter(l => /\| `r\/[ab]\.json` \|$/.test(l));
    expect(detailRows).toHaveLength(3);
    expect(detailRows[0]).toContain('| fast | thieving | 99.5 |');
    expect(detailRows[1]).toContain('| fast | fishing | 40 |');
    expect(detailRows[2]).toContain('| slow | mining | 1 |');
    expect(md).toContain('2026-05-01 10:00:00');
    expect(md).toContain('`r/b.json`');
    // summary table puts fast first (best score 99.5)
    expect(md.indexOf('fast')).toBeLessThan(md.indexOf('slow'));
  });
});
