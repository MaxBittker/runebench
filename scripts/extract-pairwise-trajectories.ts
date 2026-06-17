// Extracts compact readable transcripts + quant metrics for opus 4.8 vs 4.7 pairwise skill analysis.
// Output: analysis/pairwise/{transcripts,quant.json}
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

const ROOT = "/Users/max/workplace/rs-bench2";
const OUT = join(ROOT, "analysis/pairwise");
mkdirSync(join(OUT, "transcripts"), { recursive: true });

const SKILLS = ["attack","defence","strength","hitpoints","ranged","prayer","magic","woodcutting","fishing","mining","cooking","fletching","crafting","smithing","firemaking","thieving"];

// dir for opus48 (single run each) and opus47 best run per skill
const OPUS48_DIR = join(ROOT, "jobs/skills-30m-opus48-20260528-144410");
const OPUS47_DIR = join(ROOT, "jobs/skills-30m-opus47-20260417-230914");

function findTaskDir(jobDir: string, skill: string, pick: "only" | "best"): string | null {
  const dirs = readdirSync(jobDir).filter(d => d.startsWith(`${skill}-xp-30m__`));
  if (dirs.length === 0) return null;
  if (pick === "only") return join(jobDir, dirs[0]);
  // best by reward
  let best = dirs[0], bestR = -1;
  for (const d of dirs) {
    const rp = join(jobDir, d, "verifier/reward.txt");
    const r = existsSync(rp) ? parseFloat(readFileSync(rp, "utf8").trim()) || 0 : 0;
    if (r > bestR) { bestR = r; best = d; }
  }
  return join(jobDir, best);
}

function truncate(s: string, n: number): string {
  s = (s ?? "").replace(/\r/g, "");
  if (s.length <= n) return s;
  return s.slice(0, n) + ` …[+${s.length - n} chars]`;
}

interface Quant {
  model: string; skill: string; trial: string; reward: number | null;
  total_steps: number; wall_clock_min: number; agent_exec_min: number;
  tool_counts: Record<string, number>;
  n_execute_code: number; execute_code_chars: number;
  n_bash: number; n_write: number; n_edit: number; n_read: number;
  files_touched: string[]; check_rate_calls: number;
  text_blocks: number; text_chars: number;
  tokens: { input: number; output: number; cached: number; cache_write: number };
  wrote_memory: boolean;
  rate_samples: { t_min: number; rate: number }[]; // peak xp rate seen in check_xp_rate outputs over time
}

function parseFilesFromBash(cmd: string, set: Set<string>) {
  // crude: capture paths after cat/less/head/tail/Read and absolute-ish paths
  const re = /(?:cat|head|tail|less|bat|grep[^\n]*?)\s+([\/~][\w\-.\/]+)/g;
  let m; while ((m = re.exec(cmd))) set.add(m[1]);
  const re2 = /(\/app\/[\w\-.\/]+|\/logs\/[\w\-.\/]+)/g;
  while ((m = re2.exec(cmd))) set.add(m[1]);
}

function extract(taskDir: string, model: string, skill: string): Quant | null {
  const ccTxt = join(taskDir, "agent/claude-code.txt");
  if (!existsSync(ccTxt)) return null;
  const resultJson = JSON.parse(readFileSync(join(taskDir, "result.json"), "utf8"));
  const reward = (() => { const p = join(taskDir, "verifier/reward.txt"); return existsSync(p) ? parseFloat(readFileSync(p, "utf8").trim()) : null; })();

  const lines = readFileSync(ccTxt, "utf8").split("\n").filter(Boolean);
  const q: Quant = {
    model, skill, trial: basename(taskDir), reward,
    total_steps: 0, wall_clock_min: 0, agent_exec_min: 0,
    tool_counts: {}, n_execute_code: 0, execute_code_chars: 0,
    n_bash: 0, n_write: 0, n_edit: 0, n_read: 0,
    files_touched: [], check_rate_calls: 0,
    text_blocks: 0, text_chars: 0,
    tokens: { input: 0, output: 0, cached: 0, cache_write: 0 },
    wrote_memory: false, rate_samples: [],
  };
  const files = new Set<string>();
  const transcript: string[] = [];

  // start time for relative timestamps
  const startTs = new Date(resultJson.agent_execution?.started_at ?? resultJson.started_at).getTime();
  const minOf = (iso: string | undefined) => iso ? (new Date(iso).getTime() - startTs) / 60000 : 0;

  // track tool_use_id -> {name, t_min} so we can attribute check_xp_rate results
  const toolMeta: Record<string, { name: string; isRate: boolean; t: number }> = {};

  for (const line of lines) {
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp || obj.message?.timestamp;
    if (obj.type === "assistant") {
      q.total_steps++;
      const fm = obj.message?.usage;
      for (const blk of obj.message?.content ?? []) {
        if (blk.type === "text" && blk.text?.trim()) {
          q.text_blocks++; q.text_chars += blk.text.length;
          transcript.push(`\n💬 ${truncate(blk.text.trim(), 1200)}`);
        } else if (blk.type === "tool_use") {
          q.tool_counts[blk.name] = (q.tool_counts[blk.name] || 0) + 1;
          const t = minOf(ts);
          let isRate = false;
          if (blk.name === "mcp__rs-agent__execute_code") {
            q.n_execute_code++;
            const code = blk.input?.code ?? "";
            q.execute_code_chars += code.length;
            transcript.push(`\n🟢 [${t.toFixed(1)}m] execute_code:\n\`\`\`js\n${truncate(code, 1400)}\n\`\`\``);
          } else if (blk.name === "Bash") {
            q.n_bash++;
            const cmd = blk.input?.command ?? "";
            parseFilesFromBash(cmd, files);
            if (/check_xp_rate/.test(cmd)) { q.check_rate_calls++; isRate = true; }
            transcript.push(`\n$ [${t.toFixed(1)}m] ${truncate(cmd, 500)}`);
          } else if (blk.name === "Write") {
            q.n_write++; const fp = blk.input?.file_path ?? "";
            if (fp) files.add(fp);
            if (/memory/.test(fp)) q.wrote_memory = true;
            transcript.push(`\n✏️ [${t.toFixed(1)}m] Write ${fp}`);
          } else if (blk.name === "Edit") {
            q.n_edit++; const fp = blk.input?.file_path ?? ""; if (fp) files.add(fp);
            transcript.push(`\n✏️ [${t.toFixed(1)}m] Edit ${fp}`);
          } else if (blk.name === "Read") {
            q.n_read++; const fp = blk.input?.file_path ?? ""; if (fp) files.add(fp);
            transcript.push(`\n📖 [${t.toFixed(1)}m] Read ${fp}`);
          } else {
            transcript.push(`\n🔧 [${t.toFixed(1)}m] ${blk.name} ${truncate(JSON.stringify(blk.input ?? {}), 200)}`);
          }
          toolMeta[blk.id] = { name: blk.name, isRate, t };
        }
      }
    } else if (obj.type === "user") {
      for (const blk of obj.message?.content ?? []) {
        if (blk.type === "tool_result") {
          const meta = toolMeta[blk.tool_use_id];
          let text = "";
          if (typeof blk.content === "string") text = blk.content;
          else if (Array.isArray(blk.content)) text = blk.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
          if (!text) continue;
          // capture xp rate numbers
          if (meta?.isRate) {
            const m = text.match(/([\d.]+)\s*(?:xp\/min|XP\/min|per min)/i) || text.match(/peak[^\d]*([\d.]+)/i) || text.match(/rate[^\d]*([\d.]+)/i);
            if (m) q.rate_samples.push({ t_min: +meta.t.toFixed(1), rate: parseFloat(m[1]) });
          }
          transcript.push(`   ← ${truncate(text.replace(/\n+/g, " ⏎ "), 350)}`);
        }
      }
    }
  }

  q.tokens = {
    input: resultJson.agent_result?.n_input_tokens ?? 0,
    output: resultJson.agent_result?.n_output_tokens ?? 0,
    cached: resultJson.agent_result?.n_cache_tokens ?? 0,
    cache_write: 0,
  };
  q.wall_clock_min = minOf(resultJson.finished_at);
  q.agent_exec_min = (new Date(resultJson.agent_execution?.finished_at).getTime() - startTs) / 60000;
  q.files_touched = [...files].sort();

  // agent-written memory
  const memDir = join(taskDir, "agent/sessions/projects/-app/memory");
  let memContent = "";
  if (existsSync(memDir)) {
    for (const f of readdirSync(memDir)) {
      if (f.endsWith(".md") && f !== "MEMORY.md") {
        q.wrote_memory = true;
        memContent += `\n\n=== AGENT-WRITTEN MEMORY: ${f} ===\n` + readFileSync(join(memDir, f), "utf8");
      }
    }
  }

  // write transcript md
  const header = `# ${model} — ${skill} (30m) — reward=${reward}\n` +
    `trial: ${q.trial}\n` +
    `steps=${q.total_steps} execute_code=${q.n_execute_code} bash=${q.n_bash} writes=${q.n_write} edits=${q.n_edit} reads=${q.n_read} check_rate=${q.check_rate_calls}\n` +
    `agent_exec_min=${q.agent_exec_min.toFixed(1)} output_tokens=${q.tokens.output} text_blocks=${q.text_blocks}\n` +
    `tool_counts=${JSON.stringify(q.tool_counts)}\n` +
    `\n--- CHRONOLOGICAL TRANSCRIPT (text 💬, code 🟢, bash \$, results ←) ---\n`;
  writeFileSync(join(OUT, "transcripts", `${model}-${skill}.md`), header + transcript.join("\n") + memContent);
  return q;
}

const allQuant: Quant[] = [];
for (const skill of SKILLS) {
  const d48 = findTaskDir(OPUS48_DIR, skill, "only");
  const d47 = findTaskDir(OPUS47_DIR, skill, "best");
  if (d48) { const q = extract(d48, "opus48", skill); if (q) allQuant.push(q); }
  if (d47) { const q = extract(d47, "opus47", skill); if (q) allQuant.push(q); }
  console.log(`${skill}: 48=${d48?basename(d48):"-"} 47=${d47?basename(d47):"-"}`);
}
writeFileSync(join(OUT, "quant.json"), JSON.stringify(allQuant, null, 2));
console.log(`\nWrote ${allQuant.length} transcripts + quant.json to ${OUT}`);
