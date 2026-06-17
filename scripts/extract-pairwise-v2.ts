// v2: 4.8 (single run) vs FULL 4.7 default distribution (up to 6 runs/skill across 3 jobs).
// Emits quant for every run + compact transcripts for: 4.8 run, 4.7 median run, 4.7 best run.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

const ROOT = "/Users/max/workplace/rs-bench2";
const OUT = join(ROOT, "analysis/pairwise2");
mkdirSync(join(OUT, "transcripts"), { recursive: true });

const SKILLS = ["attack","defence","strength","hitpoints","ranged","prayer","magic","woodcutting","fishing","mining","cooking","fletching","crafting","smithing","firemaking","thieving"];
const OPUS48_DIR = join(ROOT, "jobs/skills-30m-opus48-20260528-144410");
const OPUS47_DIRS = [
  join(ROOT, "jobs/skills-30m-opus47-20260417-134318"),
  join(ROOT, "jobs/skills-30m-opus47-20260417-135014"),
  join(ROOT, "jobs/skills-30m-opus47-20260417-230914"),
];

function runsFor(jobDirs: string[], skill: string): string[] {
  const out: string[] = [];
  for (const jd of jobDirs) {
    if (!existsSync(jd)) continue;
    for (const d of readdirSync(jd)) if (d.startsWith(`${skill}-xp-30m__`)) out.push(join(jd, d));
  }
  return out;
}
const rewardOf = (dir: string) => { const p = join(dir, "verifier/reward.txt"); return existsSync(p) ? (parseFloat(readFileSync(p, "utf8").trim()) || 0) : null; };

function truncate(s: string, n: number): string {
  s = (s ?? "").replace(/\r/g, "");
  return s.length <= n ? s : s.slice(0, n) + ` …[+${s.length - n}c]`;
}

interface Quant {
  model: string; skill: string; trial: string; reward: number | null;
  total_steps: number; agent_exec_min: number; stopped_early: boolean;
  n_execute_code: number; n_bash: number; n_write: number; n_edit: number; n_read: number;
  n_disconnect: number; bg_script: boolean; reads_app_docs: number;
  text_blocks: number; text_chars: number;
  out_tokens: number;
}

function analyze(taskDir: string, model: string, skill: string, writeTranscript: boolean, tag: string): Quant | null {
  const ccTxt = join(taskDir, "agent/claude-code.txt");
  if (!existsSync(ccTxt)) return null;
  const rj = JSON.parse(readFileSync(join(taskDir, "result.json"), "utf8"));
  const reward = rewardOf(taskDir);
  const lines = readFileSync(ccTxt, "utf8").split("\n").filter(Boolean);
  const startTs = new Date(rj.agent_execution?.started_at ?? rj.started_at).getTime();
  const minOf = (iso?: string) => iso ? (new Date(iso).getTime() - startTs) / 60000 : 0;
  const q: Quant = { model, skill, trial: basename(taskDir), reward, total_steps: 0, agent_exec_min: 0, stopped_early: false,
    n_execute_code: 0, n_bash: 0, n_write: 0, n_edit: 0, n_read: 0, n_disconnect: 0, bg_script: false, reads_app_docs: 0,
    text_blocks: 0, text_chars: 0, out_tokens: rj.agent_result?.n_output_tokens ?? 0 };
  const transcript: string[] = [];
  const toolName: Record<string, { name: string; t: number }> = {};
  for (const line of lines) {
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || o.message?.timestamp;
    if (o.type === "assistant") {
      q.total_steps++;
      for (const b of o.message?.content ?? []) {
        const t = minOf(ts);
        if (b.type === "text" && b.text?.trim()) {
          q.text_blocks++; q.text_chars += b.text.length;
          if (writeTranscript) transcript.push(`\n💬 ${truncate(b.text.trim(), 700)}`);
        } else if (b.type === "tool_use") {
          if (b.name === "mcp__rs-agent__execute_code") { q.n_execute_code++; if (writeTranscript) transcript.push(`\n🟢 [${t.toFixed(1)}m] code:\n\`\`\`js\n${truncate(b.input?.code ?? "", 900)}\n\`\`\``); }
          else if (b.name === "Bash") { q.n_bash++; const c = b.input?.command ?? ""; if (/bun\s+\/?(tmp|app)?[^\n]*train|nohup|&\s*$|>\s*\/tmp\/.*\.(log|err)/.test(c)) q.bg_script = true; if (writeTranscript) transcript.push(`\n$ [${t.toFixed(1)}m] ${truncate(c, 320)}`); }
          else if (b.name === "Write") { q.n_write++; const fp = b.input?.file_path ?? ""; if (/train|\.ts$/.test(fp)) q.bg_script = true; if (writeTranscript) transcript.push(`\n✏️ [${t.toFixed(1)}m] Write ${fp}`); }
          else if (b.name === "Edit") { q.n_edit++; if (writeTranscript) transcript.push(`\n✏️ [${t.toFixed(1)}m] Edit ${b.input?.file_path ?? ""}`); }
          else if (b.name === "Read") { q.n_read++; const fp = b.input?.file_path ?? ""; if (/\/app\/(wiki|learnings|server|sdk|mcp)/.test(fp)) q.reads_app_docs++; if (writeTranscript) transcript.push(`\n📖 [${t.toFixed(1)}m] Read ${fp}`); }
          else if (b.name === "mcp__rs-agent__disconnect_bot") { q.n_disconnect++; if (writeTranscript) transcript.push(`\n🔌 [${t.toFixed(1)}m] disconnect_bot`); }
          else if (writeTranscript) transcript.push(`\n🔧 [${t.toFixed(1)}m] ${b.name} ${truncate(JSON.stringify(b.input ?? {}), 120)}`);
          toolName[b.id] = { name: b.name, t };
        }
      }
    } else if (o.type === "user" && writeTranscript) {
      for (const b of o.message?.content ?? []) {
        if (b.type === "tool_result") {
          let text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : "";
          if (text) transcript.push(`   ← ${truncate(text.replace(/\n+/g, " ⏎ "), 220)}`);
        }
      }
    }
  }
  q.agent_exec_min = minOf(rj.agent_execution?.finished_at);
  q.stopped_early = q.agent_exec_min < 28;
  // app-doc bash greps count toward reads_app_docs as well
  if (writeTranscript) {
    let mem = "";
    const memDir = join(taskDir, "agent/sessions/projects/-app/memory");
    if (existsSync(memDir)) for (const f of readdirSync(memDir)) if (f.endsWith(".md") && f !== "MEMORY.md") mem += `\n\n=== AGENT MEMORY ${f} ===\n` + readFileSync(join(memDir, f), "utf8");
    const hdr = `# ${model} [${tag}] — ${skill} — reward=${reward}\ntrial=${q.trial} steps=${q.total_steps} exec=${q.n_execute_code} bash=${q.n_bash} read=${q.n_read} write=${q.n_write} disc=${q.n_disconnect} bg_script=${q.bg_script} text_blocks=${q.text_blocks} exec_min=${q.agent_exec_min.toFixed(1)} stopped_early=${q.stopped_early}\n\n--- TRANSCRIPT (💬text 🟢code \$bash 📖read ✏️write 🔌disconnect ←result) ---\n`;
    writeFileSync(join(OUT, "transcripts", `${model}-${skill}-${tag}.md`), hdr + transcript.join("\n") + mem);
  }
  return q;
}

function median<T>(arr: T[], key: (x: T) => number): T {
  const s = [...arr].sort((a, b) => key(a) - key(b));
  return s[Math.floor((s.length - 1) / 2)];
}

const all: Quant[] = [];
const dist: any[] = [];
for (const skill of SKILLS) {
  // 4.8 (single)
  const d48 = runsFor([OPUS48_DIR], skill)[0];
  if (d48) { const q = analyze(d48, "opus48", skill, true, "run"); if (q) all.push(q); }
  // 4.7 all default runs
  const r47 = runsFor(OPUS47_DIRS, skill);
  const q47: Quant[] = [];
  for (const d of r47) { const q = analyze(d, "opus47", skill, false, ""); if (q) { all.push(q); q47.push(q); } }
  // pick median + best for transcripts
  if (q47.length) {
    const valid = q47.filter(x => x.reward != null);
    const best = valid.reduce((a, b) => (b.reward! > a.reward! ? b : a), valid[0]);
    const med = median(valid, x => x.reward!);
    const bestDir = r47.find(d => basename(d) === best.trial)!;
    const medDir = r47.find(d => basename(d) === med.trial)!;
    analyze(bestDir, "opus47", skill, true, "best");
    if (med.trial !== best.trial) analyze(medDir, "opus47", skill, true, "median");
    const rewards = valid.map(x => x.reward!).sort((a, b) => a - b);
    const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    const sd = Math.sqrt(rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / rewards.length);
    dist.push({ skill, opus48: all.find(x => x.model === "opus48" && x.skill === skill)?.reward,
      opus47_n: rewards.length, opus47_min: rewards[0], opus47_median: med.reward, opus47_mean: +mean.toFixed(1),
      opus47_max: best.reward, opus47_sd: +sd.toFixed(1), opus47_runs: rewards });
  }
}
writeFileSync(join(OUT, "quant.json"), JSON.stringify(all, null, 2));
writeFileSync(join(OUT, "distribution.json"), JSON.stringify(dist, null, 2));
console.log(`runs analyzed: ${all.length} (4.8=${all.filter(x=>x.model==="opus48").length}, 4.7=${all.filter(x=>x.model==="opus47").length})`);
console.log("transcripts:", readdirSync(join(OUT, "transcripts")).length);
