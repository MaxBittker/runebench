// Builds compact readable transcripts for the SDK/world-navigation audit (last-2-weeks runs).
// Handles all four adapter transcript formats: claude-code, codex, gemini-cli, opencode.
// Output: analysis/sdk-audit/transcripts/<label>__<skill>.md + analysis/sdk-audit/index.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

const ROOT = "/Users/max/workplace/rs-bench2";
const OUT = join(ROOT, "analysis/sdk-audit");
mkdirSync(join(OUT, "transcripts"), { recursive: true });

const JOBS: { label: string; dir: string; format: "claude-code" | "codex" | "gemini" | "opencode" }[] = [
  { label: "opus48", dir: "jobs/skills-30m-opus48-20260528-171018", format: "claude-code" },
  { label: "opus47-xhigh", dir: "jobs/skills-30m-opus47-xhigh-20260524-103619", format: "claude-code" },
  { label: "***-default", dir: "jobs/skills-30m-***-default-20260521-171134", format: "claude-code" },
  { label: "gpt55-xhigh", dir: "jobs/skills-30m-gpt55-apikey-20260523-232603", format: "codex" },
  { label: "gemini35flash-high", dir: "jobs/skills-30m-gemini35flash-high-20260524-104139", format: "gemini" },
  { label: "qwen3max", dir: "jobs/skills-30m-qwen3max-20260528-162016", format: "opencode" },
];

const ERRORISH = /error|exception|failed|cannot|can't|not found|no such|undefined is not|is not a function|timeout|timed out|unable|invalid|stuck|interrupted/i;

function truncate(s: string, n: number): string {
  s = (s ?? "").replace(/\r/g, "");
  if (s.length <= n) return s;
  return s.slice(0, n) + ` …[+${s.length - n} chars truncated]`;
}
function truncResult(s: string): string {
  return truncate(s, ERRORISH.test(s) ? 2400 : 900);
}
function flat(s: string): string {
  return s.replace(/\n+/g, " ⏎ ");
}

interface Entry {
  label: string; skill: string; trial: string; format: string;
  reward: number | null; transcript_file: string; transcript_chars: number;
  n_execute_code: number; n_errorish_results: number; agent_exec_min: number | null;
}

function readReward(taskDir: string): number | null {
  const p = join(taskDir, "verifier/reward.txt");
  if (!existsSync(p)) return null;
  const v = parseFloat(readFileSync(p, "utf8").trim());
  return isNaN(v) ? null : v;
}

function readExecMin(taskDir: string): number | null {
  const p = join(taskDir, "result.json");
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8"));
    const a = r.agent_execution?.started_at, b = r.agent_execution?.finished_at;
    if (!a || !b) return null;
    return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  } catch { return null; }
}

// ── claude-code: stream-json, one JSON per line ─────────────────────────────
function extractClaudeCode(taskDir: string, lines: string[], push: (s: string) => void, stats: { exec: number; err: number }) {
  const resultJson = existsSync(join(taskDir, "result.json")) ? JSON.parse(readFileSync(join(taskDir, "result.json"), "utf8")) : {};
  const startTs = new Date(resultJson.agent_execution?.started_at ?? resultJson.started_at ?? 0).getTime();
  const minOf = (iso: string | undefined) => iso && startTs ? ((new Date(iso).getTime() - startTs) / 60000).toFixed(1) : "?";
  const toolName: Record<string, string> = {};
  for (const line of lines) {
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp || obj.message?.timestamp;
    if (obj.type === "assistant") {
      for (const blk of obj.message?.content ?? []) {
        if (blk.type === "text" && blk.text?.trim()) {
          push(`\n💬 [${minOf(ts)}m] ${truncate(blk.text.trim(), 1200)}`);
        } else if (blk.type === "tool_use") {
          toolName[blk.id] = blk.name;
          if (blk.name === "mcp__rs-agent__execute_code") {
            stats.exec++;
            push(`\n🟢 [${minOf(ts)}m] execute_code:\n\`\`\`js\n${truncate(blk.input?.code ?? "", 2000)}\n\`\`\``);
          } else if (blk.name === "Bash") {
            push(`\n$ [${minOf(ts)}m] ${truncate(blk.input?.command ?? "", 600)}`);
          } else if (blk.name === "Read" || blk.name === "Write" || blk.name === "Edit") {
            push(`\n📄 [${minOf(ts)}m] ${blk.name} ${blk.input?.file_path ?? ""}`);
          } else {
            push(`\n🔧 [${minOf(ts)}m] ${blk.name} ${truncate(JSON.stringify(blk.input ?? {}), 300)}`);
          }
        }
      }
    } else if (obj.type === "user") {
      for (const blk of obj.message?.content ?? []) {
        if (blk.type !== "tool_result") continue;
        let text = "";
        if (typeof blk.content === "string") text = blk.content;
        else if (Array.isArray(blk.content)) text = blk.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (!text) continue;
        if (ERRORISH.test(text)) stats.err++;
        push(`   ← ${truncResult(flat(text))}`);
      }
    }
  }
}

// ── codex: JSONL of {type:"item.completed", item:{...}} ─────────────────────
function extractCodex(lines: string[], push: (s: string) => void, stats: { exec: number; err: number }) {
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "item.completed") continue;
    const it = obj.item ?? {};
    if (it.type === "agent_message" && it.text?.trim()) {
      push(`\n💬 ${truncate(it.text.trim(), 1200)}`);
    } else if (it.type === "mcp_tool_call") {
      const code = it.arguments?.code ?? JSON.stringify(it.arguments ?? {});
      if (it.tool === "execute_code") stats.exec++;
      push(`\n🟢 ${it.tool}:\n\`\`\`js\n${truncate(code, 2000)}\n\`\`\``);
      let res = "";
      if (it.error) res = `ERROR: ${typeof it.error === "string" ? it.error : JSON.stringify(it.error)}`;
      else if (it.result?.content) res = it.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (res) {
        if (ERRORISH.test(res)) stats.err++;
        push(`   ← ${truncResult(flat(res))}`);
      }
    } else if (it.type === "command_execution") {
      push(`\n$ ${truncate(it.command ?? "", 600)}`);
      const out = it.aggregated_output ?? it.output ?? "";
      if (out) {
        if (ERRORISH.test(out)) stats.err++;
        push(`   ← (exit ${it.exit_code ?? "?"}) ${truncResult(flat(out))}`);
      }
    } else if (it.type === "file_change") {
      push(`\n📄 file_change ${truncate(JSON.stringify(it.changes ?? it), 300)}`);
    } else if (it.type === "reasoning" && it.text?.trim()) {
      push(`\n🧠 ${truncate(it.text.trim(), 600)}`);
    }
  }
}

// ── opencode: console lines + JSONL events with .part ───────────────────────
function extractOpencode(lines: string[], push: (s: string) => void, stats: { exec: number; err: number }) {
  let startTs: number | null = null;
  for (const line of lines) {
    if (!line.startsWith("{")) {
      if (/^\[.*-loop\]/.test(line)) push(`\n⚙️ ${line.trim()}`);
      continue;
    }
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    if (startTs === null && obj.timestamp) startTs = obj.timestamp;
    const t = obj.timestamp && startTs ? ((obj.timestamp - startTs) / 60000).toFixed(1) : "?";
    const part = obj.part ?? {};
    if (obj.type === "text" && part.text?.trim()) {
      push(`\n💬 [${t}m] ${truncate(part.text.trim(), 1200)}`);
    } else if (obj.type === "tool_use") {
      const tool = part.tool ?? "?";
      const st = part.state ?? {};
      const input = st.input ?? {};
      if (/execute_code/.test(tool)) {
        stats.exec++;
        push(`\n🟢 [${t}m] ${tool}:\n\`\`\`js\n${truncate(input.code ?? JSON.stringify(input), 2000)}\n\`\`\``);
      } else if (tool === "bash") {
        push(`\n$ [${t}m] ${truncate(input.command ?? "", 600)}`);
      } else {
        push(`\n🔧 [${t}m] ${tool} ${truncate(JSON.stringify(input), 300)}`);
      }
      const out = typeof st.output === "string" ? st.output : st.output ? JSON.stringify(st.output) : "";
      const errored = st.status === "error" || (st.error ? true : false);
      const res = errored ? `ERROR(${st.status}): ${st.error ?? ""}\n${out}` : out;
      if (res) {
        if (errored || ERRORISH.test(res)) stats.err++;
        push(`   ← ${truncResult(flat(res))}`);
      }
    }
  }
}

// ── gemini: trajectory.json {messages:[{type, content, thoughts, toolCalls}]} ─
function extractGemini(path: string, push: (s: string) => void, stats: { exec: number; err: number }) {
  const d = JSON.parse(readFileSync(path, "utf8"));
  const msgs = d.messages ?? [];
  const startTs = msgs.length ? new Date(msgs[0].timestamp).getTime() : 0;
  for (const m of msgs) {
    const t = m.timestamp && startTs ? ((new Date(m.timestamp).getTime() - startTs) / 60000).toFixed(1) : "?";
    if (m.type === "user") continue; // task instruction, included separately
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("\n") : "";
    if (content?.trim()) push(`\n💬 [${t}m] ${truncate(content.trim(), 1200)}`);
    for (const th of m.thoughts ?? []) {
      if (th.subject) push(`\n🧠 [${t}m] ${truncate(th.subject + (th.description ? ": " + th.description : ""), 500)}`);
    }
    for (const tc of m.toolCalls ?? []) {
      const name = tc.name ?? "?";
      const args = tc.args ?? {};
      if (/execute_code/.test(name)) {
        stats.exec++;
        push(`\n🟢 [${t}m] ${name}:\n\`\`\`js\n${truncate(args.code ?? JSON.stringify(args), 2000)}\n\`\`\``);
      } else {
        push(`\n🔧 [${t}m] ${name} ${truncate(JSON.stringify(args), 400)}`);
      }
      let res = "";
      for (const r of tc.result ?? []) {
        const resp = r.functionResponse?.response;
        if (resp?.output) res += resp.output + "\n";
        else if (resp?.error) res += `ERROR: ${typeof resp.error === "string" ? resp.error : JSON.stringify(resp.error)}\n`;
        else if (resp) res += JSON.stringify(resp) + "\n";
      }
      if (res.trim()) {
        if (ERRORISH.test(res)) stats.err++;
        push(`   ← ${truncResult(flat(res.trim()))}`);
      }
    }
  }
}

// ── agent-written memory (claude-code adapters only) ────────────────────────
function agentMemory(taskDir: string): string {
  const memDir = join(taskDir, "agent/sessions/projects/-app/memory");
  if (!existsSync(memDir)) return "";
  let out = "";
  for (const f of readdirSync(memDir)) {
    if (f.endsWith(".md") && f !== "MEMORY.md") {
      out += `\n\n=== AGENT-WRITTEN MEMORY: ${f} ===\n` + readFileSync(join(memDir, f), "utf8");
    }
  }
  return out;
}

const index: Entry[] = [];
for (const job of JOBS) {
  const jobDir = join(ROOT, job.dir);
  if (!existsSync(jobDir)) { console.warn(`MISSING JOB: ${job.dir}`); continue; }
  const taskDirs = readdirSync(jobDir).filter(d => /-xp-\d+m__/.test(d)).sort();
  for (const td of taskDirs) {
    const taskDir = join(jobDir, td);
    const skill = td.split("-xp-")[0];
    const stats = { exec: 0, err: 0 };
    const transcript: string[] = [];
    const push = (s: string) => transcript.push(s);
    let src = "";
    try {
      if (job.format === "claude-code") {
        src = join(taskDir, "agent/claude-code.txt");
        if (!existsSync(src)) { console.warn(`no claude-code.txt: ${td}`); continue; }
        extractClaudeCode(taskDir, readFileSync(src, "utf8").split("\n").filter(Boolean), push, stats);
      } else if (job.format === "codex") {
        src = join(taskDir, "agent/codex.txt");
        if (!existsSync(src)) { console.warn(`no codex.txt: ${td}`); continue; }
        extractCodex(readFileSync(src, "utf8").split("\n").filter(Boolean), push, stats);
      } else if (job.format === "opencode") {
        const agentDir = join(taskDir, "agent");
        const f = existsSync(agentDir) ? readdirSync(agentDir).find(x => /^opencode-.*\.txt$/.test(x)) : undefined;
        if (!f) { console.warn(`no opencode txt: ${td}`); continue; }
        src = join(agentDir, f);
        extractOpencode(readFileSync(src, "utf8").split("\n").filter(Boolean), push, stats);
      } else if (job.format === "gemini") {
        src = join(taskDir, "agent/gemini-cli.trajectory.json");
        if (!existsSync(src)) { console.warn(`no gemini trajectory: ${td}`); continue; }
        extractGemini(src, push, stats);
      }
    } catch (e) {
      console.warn(`extract failed for ${td}: ${e}`);
      continue;
    }
    const reward = readReward(taskDir);
    const execMin = readExecMin(taskDir);
    const header = `# ${job.label} — ${skill} — reward=${reward ?? "?"}\n` +
      `model_run: ${job.label}   skill: ${skill}   trial: ${td}   format: ${job.format}\n` +
      `agent_exec_min: ${execMin?.toFixed(1) ?? "?"}   execute_code_calls: ${stats.exec}   errorish_results: ${stats.err}\n` +
      `source: ${src}\n` +
      `\nLegend: 💬 agent narration · 🧠 visible reasoning · 🟢 execute_code (game action JS) · $ bash · 🔧 other tool · ← tool result (truncated)\n` +
      `\n--- CHRONOLOGICAL TRANSCRIPT ---\n`;
    const body = transcript.join("\n") + (job.format === "claude-code" ? agentMemory(taskDir) : "");
    const outFile = join(OUT, "transcripts", `${job.label}__${skill}.md`);
    writeFileSync(outFile, header + body);
    index.push({
      label: job.label, skill, trial: td, format: job.format, reward,
      transcript_file: outFile, transcript_chars: header.length + body.length,
      n_execute_code: stats.exec, n_errorish_results: stats.err, agent_exec_min: execMin,
    });
  }
  console.log(`${job.label}: ${index.filter(e => e.label === job.label).length} transcripts`);
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2));
console.log(`\nWrote ${index.length} transcripts + index.json to ${OUT}`);
