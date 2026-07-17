#!/usr/bin/env bun
/**
 * Guard: the XP score normalization (÷8 game speed ÷25 xpRate) must agree everywhere.
 * Host-side code shares one definition per runtime (shared/extract-utils.ts for bun,
 * views/shared-constants.js for the browser), but the two container copies are
 * standalone and can't import anything. Fails if any copy drifts.
 *
 * Usage: bun scripts/check-xp-normalization-sync.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

const GAME_SPEED = 8;
const XP_MULTIPLIER = 25;

// 'defines' sites must contain the actual values; 'references' sites must use the
// shared XP_NORMALIZATION_DIVISOR instead of re-inlining them.
const SITES = [
  { path: 'shared/check_xp_rate.ts', kind: 'defines' }, // standalone copy in Docker image
  { path: 'shared/check_skill_xp.ts', kind: 'defines' }, // standalone scorer copied to /tests/
  { path: 'shared/extract-utils.ts', kind: 'defines' },
  { path: 'views/shared-constants.js', kind: 'defines' },
  { path: 'extractors/extract-skill-results.ts', kind: 'references' },
  { path: 'app/components/TrajectoryModal.js', kind: 'references' },
] as const;

const DEFINES = new RegExp(
  `60000\\s*/\\s*${GAME_SPEED}\\s*/\\s*${XP_MULTIPLIER}\\b` + // inline literal: / 8 / 25
    `|=\\s*${GAME_SPEED}\\s*\\*\\s*${XP_MULTIPLIER}\\b` + // DIVISOR = 8 * 25
    `|GAME_SPEED\\s*=\\s*${GAME_SPEED}\\b[\\s\\S]*XP_MULTIPLIER\\s*=\\s*${XP_MULTIPLIER}\\b`,
);
const REFERENCES = /XP_NORMALIZATION_DIVISOR/;

let failed = false;
for (const { path, kind } of SITES) {
  let src: string;
  try {
    src = readFileSync(join(ROOT, path), 'utf-8');
  } catch {
    console.error(`FAIL ${path} — file not found (was it moved? update SITES)`);
    failed = true;
    continue;
  }
  if (kind === 'defines' ? DEFINES.test(src) : REFERENCES.test(src)) {
    console.log(`ok   ${path}`);
  } else {
    console.error(
      kind === 'defines'
        ? `FAIL ${path} — no ÷${GAME_SPEED}/÷${XP_MULTIPLIER} normalization found. ` +
            `If the divisor changed, change it in every 'defines' site: ` +
            SITES.filter(s => s.kind === 'defines').map(s => s.path).join(', ')
        : `FAIL ${path} — expected a reference to the shared XP_NORMALIZATION_DIVISOR`,
    );
    failed = true;
  }
}

// The checked-in docker/ copy must match shared/ or the next image ships stale output.
const sharedCli = readFileSync(join(ROOT, 'shared/check_xp_rate.ts'), 'utf-8');
let dockerCli = '';
try {
  dockerCli = readFileSync(join(ROOT, 'docker/check_xp_rate.ts'), 'utf-8');
} catch {
  dockerCli = '';
}
if (dockerCli && dockerCli !== sharedCli) {
  console.error(
    'FAIL docker/check_xp_rate.ts differs from shared/check_xp_rate.ts — ' +
      'run `cp shared/check_xp_rate.ts docker/check_xp_rate.ts`',
  );
  failed = true;
} else if (dockerCli) {
  console.log('ok   docker/check_xp_rate.ts in sync with shared/');
}

if (failed) {
  console.error('\nxp normalization is out of sync.');
  process.exit(1);
}
console.log(`\nall ${SITES.length + 1} sites agree: raw XP ÷ ${GAME_SPEED * XP_MULTIPLIER} = score.`);
