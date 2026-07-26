#!/usr/bin/env bun
// Extract a compact, timed cooperation transcript per team run for analysis.
// One file per (family, model): scores + per-bot skill split + deduped timed chat.
// Output: results/team/analysis/<family>__<model>.txt
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const FAMILIES = ["crafting-team", "magic-team", "smith-team"];
const OUT = "results/team/analysis";
mkdirSync(OUT, { recursive: true });

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

type Row = { family: string; model: string; reward: number; file: string };
const index: Row[] = [];

for (const family of FAMILIES) {
  const jobs = readdirSync("jobs").filter((d) => d.startsWith(`${family}-`) && d.includes("-2026"));
  // group by model (strip family prefix and -YYYYMMDD-HHMMSS suffix), keep latest usable
  const byModel = new Map<string, { dir: string; stamp: string }>();
  for (const d of jobs) {
    const m = d.slice(family.length + 1).replace(/-(\d{8})-(\d{6})$/, "");
    const stampMatch = d.match(/-(\d{8})-(\d{6})$/);
    if (!stampMatch) continue;
    const stamp = stampMatch[1] + stampMatch[2];
    const prev = byModel.get(m);
    // find trial reward.json
    const trialParent = join("jobs", d);
    const trial = readdirSync(trialParent).find((x) => x.includes("__"));
    if (!trial) continue;
    const rj = join(trialParent, trial, "verifier", "reward.json");
    if (!existsSync(rj)) continue;
    let chatCount = 0;
    try {
      chatCount = JSON.parse(readFileSync(rj, "utf8")).chatCount ?? 0;
    } catch {}
    if (chatCount === 0) continue; // dead / fast-fail
    if (!prev || stamp > prev.stamp) byModel.set(m, { dir: join(trialParent, trial), stamp });
  }

  for (const [model, { dir }] of [...byModel].sort()) {
    const rj = join(dir, "verifier", "reward.json");
    const r = JSON.parse(readFileSync(rj, "utf8"));
    const reward = r.reward ?? r.totalXp ?? 0;

    // dedup chat by sender+text+tick, sort by elapsedMs
    const seen = new Set<string>();
    const chat = (r.chat ?? [])
      .filter((c: any) => {
        const k = `${c.sender}|${c.tick}|${c.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a: any, b: any) => (a.elapsedMs ?? 0) - (b.elapsedMs ?? 0));

    // per-bot outcome summary (family-specific skill)
    const skill = family === "crafting-team" ? "crafting" : family === "magic-team" ? "magic" : "finalSmithing";
    const perBot = Object.entries(r.perBot ?? {}).map(([bot, v]: any) => {
      const s = v[skill] ?? v.finalSmithing ?? {};
      const mine = v.finalMining ? ` mining=${v.finalMining.level}` : "";
      return `${bot}: ${skill.replace("final", "").toLowerCase()} L${s.level ?? "?"}/${s.xp ?? "?"}xp${mine}`;
    });

    const header = [
      `RUN: ${family} / ${model}`,
      `REWARD (score): ${reward}`,
      family === "smith-team" ? `BEST ITEM: ${r.bestItem?.name} (cost ${r.bestItem?.cost}, by ${r.bestItem?.bot}, at ${mmss(r.bestItem?.elapsedMs ?? 0)}) suspectedCheat=${r.suspectedCheat}` : "",
      family === "magic-team" ? `BEST: ${r.best?.bot} magic L${r.best?.level} / ${r.best?.xp}xp at ${mmss((r.best?.elapsedSecs ?? 0) * 1000)}` : "",
      family === "crafting-team" ? `TOP BOT: ${r.topBot?.bot} (${r.topBot?.xp}xp) topShare=${r.topShare}` : "",
      `PER-BOT OUTCOME: ${perBot.join(" | ")}`,
      `CHAT MESSAGES: ${chat.length}`,
      `${"=".repeat(60)}`,
      `TIMED CHAT TRANSCRIPT ([mm:ss] Sender: message):`,
      "",
    ].filter(Boolean).join("\n");

    const lines = chat.map((c: any) => `[${mmss(c.elapsedMs ?? 0)}] ${c.sender}: ${c.text}`);
    const path = join(OUT, `${family}__${model}.txt`);
    writeFileSync(path, header + "\n" + lines.join("\n") + "\n");
    index.push({ family, model, reward, file: path });
  }
}

writeFileSync(join(OUT, "_index.json"), JSON.stringify(index, null, 2));
console.log(`Wrote ${index.length} run transcripts to ${OUT}/`);
for (const f of FAMILIES) {
  const rows = index.filter((r) => r.family === f);
  console.log(`  ${f}: ${rows.length} runs — ${rows.map((r) => r.model).join(", ")}`);
}
