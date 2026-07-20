#!/usr/bin/env bun
/**
 * Regenerate app/wiki-data.js — the wiki content the results website's WikiBrowser serves.
 *
 * The wiki itself lives in rs-sdk and is what the Docker image mounts at /app/wiki, so
 * rs-sdk is the single source of truth. This repo used to keep its own copy of the whole
 * tree, which silently drifted (2138 files here vs 2250 upstream, and a "Cowhides" item
 * name the upstream copy had already fixed) while the site claimed to show what agents saw.
 *
 * Only the generated blob is committed. Regenerate when the image's rs-sdk pin moves:
 *   bun scripts/build-wiki-data.ts                    # reads ../rs-sdk/wiki
 *   RS_SDK_PATH=/path/to/rs-sdk bun scripts/build-wiki-data.ts
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

// Folders shown in the browser, in display order. The image also ships wiki/quests/,
// which the site has never listed — add it here if it should be visible.
const FOLDERS = ['skills', 'shops', 'npcs', 'items'];

const sdkPath = resolve(process.env.RS_SDK_PATH || join(import.meta.dir, '..', '..', 'rs-sdk'));
const wikiRoot = join(sdkPath, 'wiki');

if (!existsSync(wikiRoot)) {
  console.error(`No wiki at ${wikiRoot}`);
  console.error('Point RS_SDK_PATH at an rs-sdk checkout (the same commit the image pins).');
  process.exit(1);
}

let sdkCommit = 'unknown';
try {
  sdkCommit = execSync('git rev-parse HEAD', { cwd: sdkPath, encoding: 'utf-8' }).trim();
} catch {
  console.warn(`Warning: ${sdkPath} is not a git checkout — commit will be recorded as "unknown"`);
}

const tree = FOLDERS.map(name => {
  const dir = join(wikiRoot, name);
  if (!existsSync(dir)) {
    console.error(`Missing folder: ${dir}`);
    process.exit(1);
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const contents: Record<string, string> = {};
  for (const f of files) contents[f] = readFileSync(join(dir, f), 'utf-8');
  return { name, count: files.length, files, contents };
});

const outFile = join(import.meta.dir, '..', 'app', 'wiki-data.js');
writeFileSync(
  outFile,
  `// Auto-generated wiki tree data — do not edit\n` +
    `// Source: rs-sdk wiki/ @ ${sdkCommit}\n` +
    `// Regenerate: bun scripts/build-wiki-data.ts\n` +
    `export const WIKI_TREE = ${JSON.stringify(tree)};\n`
);

const total = tree.reduce((n, f) => n + f.count, 0);
console.log(`Wrote ${outFile}`);
console.log(`  rs-sdk ${sdkCommit}`);
console.log(`  ${total} files: ${tree.map(f => `${f.name}=${f.count}`).join(' ')}`);
