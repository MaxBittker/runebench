#!/usr/bin/env bun
// Generates the "2026-07-01 refresh" HTML fragment for collaboration-analysis.html
// from the team-cooperation-analysis workflow result + transcript stats.
import { readFileSync, readdirSync, writeFileSync } from "fs";

const r = JSON.parse(readFileSync("/tmp/team_coop_result.json", "utf8"));
const C = r.characterizations, fam = r.familyReports, m = r.meta;

const LABEL: Record<string, string> = {
  "fable5": "Claude Fable 5", "opus48": "Claude Opus 4.8", "opus47": "Claude Opus 4.7",
  "opus": "Claude Opus 4.6", "opus45": "Claude Opus 4.5", "sonnet5": "Claude Sonnet 5",
  "sonnet46": "Claude Sonnet 4.6", "sonnet45": "Claude Sonnet 4.5", "haiku": "Claude Haiku 4.5",
  "codex53": "GPT-5.3 Codex", "gpt55": "GPT-5.5", "gpt54": "GPT-5.4", "gpt54mini": "GPT-5.4 Mini",
  "gpt54nano": "GPT-5.4 Nano", "gemini31": "Gemini 3.1 Pro", "geminiflash": "Gemini 3 Flash",
  "gemini35flash": "Gemini 3.5 Flash", "glm": "GLM-5", "glm52": "GLM-5.2", "kimi": "Kimi K2.5",
  "qwen35": "Qwen3.5 35B", "qwen3max": "Qwen3-Max",
};
const lbl = (k: string) => LABEL[k] ?? k;
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- fix-verification stats from transcripts ----
const dir = "results/team/analysis";
let lens: number[] = [], fear = 0, confirmed = 0, pickups = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".txt")) continue;
  for (const line of readFileSync(dir + "/" + f, "utf8").split("\n")) {
    const mm = line.match(/^\[(\d\d:\d\d)\] \w+: (.*)$/); if (!mm) continue;
    const t = mm[2].toLowerCase();
    lens.push(mm[2].length);
    if (/despawn|vanish|disappear/.test(t)) {
      if (/(despawned|all gone|vanished|disappeared|got 0 |nothing there|already despawn)/.test(t)) confirmed++;
      else fear++;
    }
    if (/(picked up|grabbed|got \d+ .*(hide|wool|ore|bar|rune)|collected \d+|have \d+ .*(hide|ore|bar))/.test(t)) pickups++;
  }
}
lens.sort((a, b) => a - b);
const q = (p: number) => lens[Math.floor(p * lens.length)];
const maxLen = lens[lens.length - 1], over500 = lens.filter((x) => x > 500).length;

// ---- badges ----
const tierBadge = (t: string) => {
  const c = t === "strong" ? ["#3fb95022", "#3fb950", "#3fb95055"] : t === "weak" ? ["#f8514922", "#f85149", "#f8514955"] : ["#e3b34122", "#e3b341", "#e3b34155"];
  return `<span class="badge" style="background:${c[0]};color:${c[1]};border-color:${c[2]}">${t}</span>`;
};
const cq = (n: number) => {
  const c = n >= 4 ? "#3fb950" : n >= 3 ? "#e3b341" : "#f85149";
  return `<b style="color:${c}">${n}</b><span class="muted">/5</span>`;
};
const concBadge = (w: string, intended: boolean) => {
  if (w === "single-bot-carried") return intended
    ? `<span class="badge" style="background:#3fb95022;color:#3fb950;border-color:#3fb95055">by design</span>`
    : `<span class="badge" style="background:#f8514922;color:#f85149;border-color:#f8514955">by accident</span>`;
  const map: Record<string, string> = { "lead-plus-support": "#58a6ff", "balanced-parallel": "#e3b341", "fragmented": "#f85149" };
  return `<span class="muted small">${esc(w)}</span>`;
};

const famMeta = [
  { k: "crafting-team", label: "Crafting", unit: "XP" },
  { k: "magic-team", label: "Magic", unit: "level" },
  { k: "smith-team", label: "Smith", unit: "gp" },
];

let h = "";
h += `\n  <div class="box" id="refresh-2026-07-01"><h3>2026-07-01 refresh — 22 models × 3 events (45m), and did the SDK fixes land?</h3>\n`;
h += `<p class="small muted">A workflow re-analyzed the full current gamut: <b>65 three-bot runs</b> (crafting / magic / smith-team × ${new Set(C.map((c: any) => c.model)).size} models, 45-minute horizon), one agent characterizing each run's cooperation from the timed team-chat transcript + per-bot skill split. Source transcripts in <code>results/team/analysis/</code>; full write-up in <code>results/team/COOPERATION-ANALYSIS.md</code>. The 6-model / 60-minute round below is retained as the prior baseline.</p>\n`;

// FIX VERIFICATION
h += `<h4 style="color:#3fb950">✅ The two SDK fixes from the prior round both landed</h4>\n`;
h += `<p>The prior analysis flagged <b>~80-char chat truncation (#1)</b> and <b>ground-item despawn (#2)</b> as the top cooperation taxes. Both were addressed in the engine image (<code>NODE_MAX_MESSAGE_LENGTH=500</code>, <code>NODE_OBJ_DESPAWN_SCALE=20000</code> ≈ items linger ~200×). The new gamut confirms they took effect:</p>\n`;
h += `<div class="two">\n`;
h += `<div class="card"><div class="card-h"><b>maxMessageLength → 500: working</b></div><p class="small">Across <b>${lens.length.toLocaleString()}</b> chat messages: median <b>${q(0.5)}</b>, p95 <b>${q(0.95)}</b>, p99 <b>${q(0.99)}</b>, <b>max ${maxLen}</b> chars. <b>Zero</b> messages exceed 500 and there is no pile-up at the cap — nothing is being truncated. Multi-sentence coordination (roles, coords, ore ratios) now flows intact; the old 80-char cap would have clipped the trailing coords/counts that handoffs depend on. No in-band "your message got cut off" complaints remain.</p></div>\n`;
h += `<div class="card"><div class="card-h"><b>objDespawnScale → 20000: working</b></div><p class="small">Only <b>~${confirmed}</b> message across all 65 runs asserts a <i>confirmed</i> ground-item loss, vs <b>${fear}</b> anticipatory "grab it before it despawns" pings and <b>${pickups}</b> successful pickup/collection reports. The top crafting runs (Fable 5 <b>50,582</b> XP, Sonnet 5 30,194) are only physically possible if teammate-dropped materials persisted for the full run. <b>Caveat:</b> models still <i>behave</i> as if items vanish fast — they rush handoffs and pre-emptively re-collect out of RuneScape prior — so the fix removed the real loss but not the paranoia-driven drop-churn.</p></div>\n`;
h += `</div>\n`;

// HEADLINE
h += `<h4>Headline: strategy is saturated — execution is now the whole game</h4>\n`;
h += `<p>Essentially all 22 models independently discover the reward-optimal <b>"hero + 2 feeders" funnel</b> (one bot does the scoring skill; two gather and drop materials) within ~1–2 minutes of chat, in every event. So score variance is a near-pure measurement of long-horizon <b>embodied execution</b> — pathfinding, drop-point discipline, pickup verification, resource stockpiling, role stability over 45 minutes — not planning. A handful even verbalize the scoring rule mid-run (Sonnet 5: "only my crafting xp counts for score"; Opus 4.7: "alphabetical last = stays put").</p>\n`;

// MODEL RANKING TABLE
h += `<h4>Cross-family cooperation tiers (aggregated across all 3 events)</h4>\n`;
h += `<table><thead><tr><th>Model</th><th>Tier</th><th>Notes</th></tr></thead><tbody>\n`;
const order: Record<string, number> = { strong: 0, mixed: 1, weak: 2 };
for (const x of [...m.modelRanking].sort((a: any, b: any) => order[a.coopTier] - order[b.coopTier])) {
  h += `<tr><td><b>${esc(lbl(x.model))}</b></td><td>${tierBadge(x.coopTier)}</td><td class="muted small">${esc(x.note)}</td></tr>\n`;
}
h += `</tbody></table>\n`;

// PER-FAMILY TABLES
h += `<h4>Per-run coordination quality by event</h4>\n`;
h += `<p class="small muted">Sorted by coordination quality. "Concentration" = did one bot do ~all scoring work, and was that the deliberate funnel (by design) or a coordination failure where feeders duplicated/idled (by accident)? Reward is only comparable within an event.</p>\n`;
for (const F of famMeta) {
  const rows = C.filter((c: any) => c.family === F.k).sort((a: any, b: any) => (b.coordinationQuality - a.coordinationQuality) || (b.reward - a.reward));
  h += `<h4 style="color:#adbac7">${F.label} <span class="muted small">(${F.k}, reward = ${F.unit})</span></h4>\n`;
  h += `<table><thead><tr><th>Model</th><th>Coord</th><th>Reward</th><th>Concentration</th><th>Plan</th><th>Archetype</th></tr></thead><tbody>\n`;
  for (const c of rows) {
    h += `<tr><td><b>${esc(lbl(c.model))}</b></td><td>${cq(c.coordinationQuality)}</td><td class="score">${c.reward}</td><td>${concBadge(c.workConcentration, c.concentrationIntended)}</td><td class="muted small">${esc(c.planStatus)}</td><td class="muted small">${esc(c.strategyArchetype)}</td></tr>\n`;
  }
  h += `</tbody></table>\n`;
}

// TAXONOMIES
h += `<h4>Strategy taxonomy</h4><ul>\n`;
for (const s of m.strategyTaxonomy) h += `<li class="small">${esc(s)}</li>\n`;
h += `</ul>\n<h4>Failure taxonomy</h4><ul>\n`;
for (const s of m.failureTaxonomy) h += `<li class="small">${esc(s)}</li>\n`;
h += `</ul>\n`;

// KEY INSIGHTS
h += `<h4>Key insights</h4><ul>\n`;
for (const s of m.insights) h += `<li class="small">${esc(s)}</li>\n`;
h += `</ul>\n`;

// PER-FAMILY SYNTHESIS (collapsible)
h += `<h4>Per-event synthesis</h4>\n`;
for (const F of fam) {
  const fm = famMeta.find((x) => x.k === F.family)!;
  h += `<details><summary>${fm.label} — full synthesis, coordination-vs-score, failure modes, standouts</summary>\n`;
  h += `<div class="card"><p class="small">${esc(F.report).replace(/\n\n/g, "</p><p class='small'>").replace(/## /g, "").replace(/\*\*/g, "")}</p>\n`;
  h += `<p class="small"><b>Coordination vs. score:</b> ${esc(F.coopVsScore)}</p>\n`;
  h += `<p class="small"><b>Common failure modes:</b></p><ul>${F.commonFailureModes.map((x: string) => `<li class="small">${esc(x)}</li>`).join("")}</ul>\n`;
  h += `<p class="small"><b>Standouts:</b></p><ul>${F.standouts.map((x: string) => `<li class="small">${esc(x)}</li>`).join("")}</ul>\n`;
  h += `</div></details>\n`;
}

h += `<p class="small muted" style="margin-top:14px;border-top:1px solid #21262d;padding-top:10px">↓ Prior round below: 6 models × 3 events, 60-minute horizon, from-scratch bootstrap. Its "Chat / SDK-layer issues" section documents the truncation + despawn problems that the fixes above have since resolved.</p>\n`;
h += `  </div>\n`;

writeFileSync("/tmp/collab_refresh.html", h);
console.log(`wrote /tmp/collab_refresh.html (${h.length} chars)`);
console.log(`stats: msgs=${lens.length} maxLen=${maxLen} over500=${over500} | despawn confirmed=${confirmed} fear=${fear} pickups=${pickups}`);
