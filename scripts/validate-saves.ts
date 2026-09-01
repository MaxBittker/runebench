/**
 * Parity check: declarative saveConfig output vs the legacy binary .sav blobs.
 *
 * For each gold condition with a saveConfig, generates the save via
 * shared/save-generator.ts and compares the *parsed game state* (position,
 * skills, non-zero varps, inventories) against the legacy binary in shared/.
 * Byte-equality is not expected (login timestamp + CRC differ).
 *
 * Usage: bun scripts/validate-saves.ts
 * Exits non-zero on any mismatch.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createSaveData } from '../shared/save-generator';
import { parseSave, type ParsedSave } from '../shared/save-parser';
import { GOLD_CONDITIONS } from '../generate-tasks';

const SHARED_DIR = join(import.meta.dir, '..', 'shared');

function diffSaves(label: string, legacy: ParsedSave, generated: ParsedSave): string[] {
  const errors: string[] = [];

  const lp = legacy.position, gp = generated.position;
  if (lp.x !== gp.x || lp.z !== gp.z || lp.level !== gp.level) {
    errors.push(`position: legacy (${lp.x},${lp.z},${lp.level}) vs generated (${gp.x},${gp.z},${gp.level})`);
  }

  for (let i = 0; i < 21; i++) {
    const ls = legacy.skills[i]!, gs = generated.skills[i]!;
    if (ls.xp !== gs.xp || ls.level !== gs.level) {
      errors.push(`skill[${i}]: legacy lvl=${ls.level} xp=${ls.xp} vs generated lvl=${gs.level} xp=${gs.xp}`);
    }
  }

  const varpIds = new Set([
    ...Object.keys(legacy.varps).map(Number),
    ...Object.keys(generated.varps).map(Number),
  ]);
  for (const id of varpIds) {
    const lv = legacy.varps[id] ?? 0, gv = generated.varps[id] ?? 0;
    if (lv !== gv) errors.push(`varp[${id}]: legacy ${lv} vs generated ${gv}`);
  }

  const invTypes = new Set([...legacy.inventories.keys(), ...generated.inventories.keys()]);
  for (const type of invTypes) {
    const li = legacy.inventories.get(type) ?? [];
    const gi = generated.inventories.get(type) ?? [];
    const key = (it: { slot: number; id: number; count: number }) => `${it.slot}:${it.id}x${it.count}`;
    const lset = li.map(key).sort().join(',');
    const gset = gi.map(key).sort().join(',');
    if (lset !== gset) {
      errors.push(`inventory type ${type}: legacy [${lset}] vs generated [${gset}]`);
    }
  }

  return errors;
}

let failures = 0;
let checked = 0;

for (const condition of GOLD_CONDITIONS) {
  if (!condition.saveConfig) continue;
  const legacyPath = join(SHARED_DIR, `agent-gold-${condition.slug}.sav`);
  if (!existsSync(legacyPath)) {
    console.log(`SKIP ${condition.slug}: no legacy binary at ${legacyPath} (already removed?)`);
    continue;
  }
  checked++;

  const legacy = parseSave(new Uint8Array(readFileSync(legacyPath)));
  const generated = parseSave(createSaveData(condition.saveConfig));
  const errors = diffSaves(condition.slug, legacy, generated);

  if (errors.length === 0) {
    console.log(`OK   ${condition.slug}: generated save matches legacy binary`);
  } else {
    failures++;
    console.log(`FAIL ${condition.slug}:`);
    for (const e of errors) console.log(`     ${e}`);
  }
}

console.log(`\n${checked} condition(s) checked, ${failures} mismatch(es).`);
process.exit(failures > 0 ? 1 : 0);
