#!/usr/bin/env bun
// Prerender static text components into index.html so the page is readable
// without running JavaScript. React's createRoot().render() in app/index.js
// wipes #root on mount, so the SSR markup only ships to non-JS clients
// (crawlers, LLM fetchers, curl) — for browsers it's a brief pre-mount flash.
//
// Run: bun scripts/prerender.ts
//
// AgentInterface is intentionally not imported: WikiBrowser pulls in
// app/wiki-data.js (~575k tokens of nested arrays). Its prose is inlined below.

import * as React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

(globalThis as any).React = React;
(globalThis as any).htm = htm;

const { Hero } = await import('../app/components/Hero.js');
const { Overview } = await import('../app/components/Overview.js');
const { Discussion } = await import('../app/components/Discussion.js');
const { Footer } = await import('../app/components/Footer.js');

const AgentInterfaceStatic = `<section class="section">
  <div class="container is-max-desktop">
    <div class="columns is-centered has-text-centered">
      <div class="column is-four-fifths">
        <h2 class="title is-3">How Agents See the World</h2>
      </div>
    </div>
    <div class="agent-row">
      <div class="agent-row-text">
        <div class="agent-panel-label">TypeScript SDK</div>
        <p>Agents play the game by writing and executing TypeScript snippets against an emulated game server. The SDK provides access to reading game state and performing actions.</p>
      </div>
    </div>
    <div class="agent-row">
      <div class="agent-row-text">
        <div class="agent-panel-label">Game Knowledge</div>
        <p>Each agent is given a folder of markdown files extracted from the game wiki — skill guides, item stats, NPC locations, and quest walkthroughs. They can search the files to inform their strategy.</p>
      </div>
    </div>
  </div>
</section>`;

const ssr = [
  renderToStaticMarkup(React.createElement(Hero)),
  renderToStaticMarkup(React.createElement(Overview)),
  AgentInterfaceStatic,
  renderToStaticMarkup(React.createElement(Discussion)),
  renderToStaticMarkup(React.createElement(Footer)),
].join('\n');

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'index.html');
let indexHtml = readFileSync(indexPath, 'utf8');

const START = '<!-- PRERENDER:START -->';
const END = '<!-- PRERENDER:END -->';
const block = `${START}\n${ssr}\n${END}`;

if (indexHtml.includes(START)) {
  indexHtml = indexHtml.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`),
    () => block,
  );
} else if (indexHtml.includes('<div id="root"></div>')) {
  indexHtml = indexHtml.replace(
    '<div id="root"></div>',
    `<div id="root">\n${block}\n</div>`,
  );
} else {
  console.error('prerender: could not find <div id="root"></div> or markers');
  process.exit(1);
}

writeFileSync(indexPath, indexHtml);
console.log(`prerender: ${ssr.length} chars written to index.html`);
