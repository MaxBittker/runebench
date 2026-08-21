#!/usr/bin/env bun
/**
 * Generates shared/item-values.json — obj id → { name, cost } for every item
 * config in the engine content, so verifiers/watchers can price arbitrary
 * holdings (store value). Used by the dragon-team task to score the covert
 * selfish bot's final WEALTH (coins + store value of items held).
 *
 * Sources (engine content in the rs-sdk checkout — same data the Docker
 * image is built from):
 *   - engine/data/symbols/obj.sym    obj name → numeric id
 *   - content/scripts/** /*.obj      obj name → cost= and name=
 *
 * Usage: bun scripts/generate-item-values.ts [path-to-rs-sdk]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const RS_SDK = process.argv[2] ?? join(import.meta.dir, '../../rs-sdk');
const OUT_FILE = join(import.meta.dir, '../shared/item-values.json');

const OBJ_SYM = join(RS_SDK, 'server/engine/data/symbols/obj.sym');
const CONTENT_SCRIPTS = join(RS_SDK, 'server/content/scripts');

// ── obj name → id (obj.sym: "<id>\t<name>") ──────────────────────
const objIds = new Map<string, number>();
for (const line of readFileSync(OBJ_SYM, 'utf-8').split('\n')) {
  const [id, name] = line.split('\t');
  if (id !== undefined && name) objIds.set(name.trim(), parseInt(id));
}

// ── scan all .obj config blocks for cost= and name= ──────────────
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.obj')) yield p;
  }
}

const values: Record<number, { name: string; cost: number }> = {};
let blocks = 0;
for (const file of walk(CONTENT_SCRIPTS)) {
  const text = readFileSync(file, 'utf-8');
  let current: string | null = null;
  let cost = 1;
  let display: string | null = null;
  const flush = () => {
    if (!current) return;
    const id = objIds.get(current);
    if (id !== undefined) {
      values[id] = { name: display ?? current, cost };
      blocks++;
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[([a-z0-9_]+)\]$/);
    if (header) {
      flush();
      current = header[1]!;
      cost = 1;
      display = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('cost=')) cost = parseInt(line.slice(5)) || 1;
    else if (line.startsWith('name=')) display = line.slice(5);
  }
  flush();
}

writeFileSync(OUT_FILE, JSON.stringify(values) + '\n');
console.log(`Wrote ${blocks} item values → ${OUT_FILE}`);
for (const probe of [995, 1540, 536, 1747, 1149]) {
  console.log(`  ${probe}: ${JSON.stringify(values[probe])}`);
}
