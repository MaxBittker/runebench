#!/usr/bin/env bun
/**
 * Generates shared/smithing-table.json — the canonical list of items the
 * Smithing skill can produce on this server, with obj IDs, store values, and
 * level requirements. Used by the smith-team task's watcher + verifier to
 * validate that a held item could have been legitimately smithed.
 *
 * Sources (engine content in the rs-sdk checkout — same data the Docker
 * image is built from):
 *   - skill_smithing/configs/smithing/smithing.dbrow   anvil recipes
 *   - skill_smithing/configs/smelting/smelting.struct  furnace recipes (bars)
 *   - engine/data/symbols/obj.sym                      obj name → numeric id
 *   - content/scripts/** /*.obj                        obj name → cost (store value)
 *
 * Usage: bun scripts/generate-smithing-table.ts [path-to-rs-sdk]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const RS_SDK = process.argv[2] ?? join(import.meta.dir, '../../rs-sdk');
const OUT_FILE = join(import.meta.dir, '../shared/smithing-table.json');

const SMITHING_DBROW = join(RS_SDK, 'server/content/scripts/skill_smithing/configs/smithing/smithing.dbrow');
const SMELTING_STRUCT = join(RS_SDK, 'server/content/scripts/skill_smithing/configs/smelting/smelting.struct');
const OBJ_SYM = join(RS_SDK, 'server/engine/data/symbols/obj.sym');
const CONTENT_SCRIPTS = join(RS_SDK, 'server/content/scripts');

interface Recipe {
  /** engine obj name, e.g. "rune_2h_sword" */
  name: string;
  /** numeric obj id (matches save files + live inventory) */
  id: number;
  /** store value from the obj config's cost= field */
  cost: number;
  /** Smithing level required to make it */
  level: number;
  /** how it's made: "anvil" (bar → item) or "furnace" (ore → bar) */
  method: 'anvil' | 'furnace';
  /** bar consumed (anvil recipes) or primary ore (furnace recipes) */
  input: string | null;
  inputAmount: number;
  /** items produced per smith action */
  productAmount: number;
}

// ── obj name → id (obj.sym: "<id>\t<name>") ──────────────────────
const objIds = new Map<string, number>();
for (const line of readFileSync(OBJ_SYM, 'utf-8').split('\n')) {
  const [id, name] = line.split('\t');
  if (id !== undefined && name) objIds.set(name.trim(), parseInt(id));
}

// ── obj name → cost (scan all .obj config blocks) ────────────────
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.obj')) yield p;
  }
}

const objCosts = new Map<string, number>();
for (const file of walk(CONTENT_SCRIPTS)) {
  const text = readFileSync(file, 'utf-8');
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[([a-z0-9_]+)\]$/);
    if (header) { current = header[1]!; continue; }
    if (current && line.startsWith('cost=')) {
      objCosts.set(current, parseInt(line.slice(5)));
    }
  }
}

// ── parse smithing.dbrow (anvil recipes) ─────────────────────────
const recipes: Recipe[] = [];

function parseBlocks(text: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let block: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { block = {}; blocks.push(block); continue; }
    if (!block) continue;
    // dbrow lines: "data=key,value"; struct lines: "param=key,value"
    const m = line.match(/^(?:data|param)=([a-z_]+),(.*)$/);
    if (m) block[m[1]!] = m[2]!;
  }
  return blocks;
}

for (const b of parseBlocks(readFileSync(SMITHING_DBROW, 'utf-8'))) {
  const name = b.product;
  if (!name || !b.levelrequired) continue;
  const id = objIds.get(name);
  if (id === undefined) { console.warn(`  no obj id for ${name}, skipping`); continue; }
  recipes.push({
    name,
    id,
    cost: objCosts.get(name) ?? 1,
    level: parseInt(b.levelrequired),
    method: 'anvil',
    input: b.bar ?? null,
    inputAmount: parseInt(b.bar_amount ?? '1'),
    productAmount: parseInt(b.product_amount ?? '1'),
  });
}

// ── parse smelting.struct (furnace recipes — bars count too) ─────
for (const b of parseBlocks(readFileSync(SMELTING_STRUCT, 'utf-8'))) {
  const name = b.product;
  if (!name || !b.levelrequired) continue;
  const id = objIds.get(name);
  if (id === undefined) { console.warn(`  no obj id for ${name}, skipping`); continue; }
  recipes.push({
    name,
    id,
    cost: objCosts.get(name) ?? 1,
    level: parseInt(b.levelrequired),
    method: 'furnace',
    input: b.ingredient ?? null,
    inputAmount: 1,
    productAmount: parseInt(b.bar_count ?? '1'),
  });
}

// Dedupe by obj id, keeping the LOWEST level requirement (an item counts if
// the holder could have made it any legitimate way).
const byId = new Map<number, Recipe>();
for (const r of recipes) {
  const existing = byId.get(r.id);
  if (!existing || r.level < existing.level) byId.set(r.id, r);
}

const table = [...byId.values()].sort((a, b) => a.cost - b.cost);
writeFileSync(OUT_FILE, JSON.stringify(table, null, 2) + '\n');

console.log(`Wrote ${table.length} smithable items → ${OUT_FILE}`);
console.log('\nTop 15 by value:');
for (const r of table.slice(-15).reverse()) {
  console.log(`  ${String(r.cost).padStart(7)}gp  lvl ${String(r.level).padStart(2)}  ${r.name} (id ${r.id}, ${r.method})`);
}
