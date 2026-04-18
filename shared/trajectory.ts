/**
 * Trajectory parsing — extracts agent step history from various agent log
 * formats (Claude Code, Codex, Gemini CLI, OpenCode). Emits a uniform
 * TrajectoryStep[] sequence for the trajectory viewer.
 *
 * Shared by:
 *   - extractors/extract-skill-results.ts
 *   - extractors/extract-gold-results.ts
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface TrajectoryStep {
  source: 'agent' | 'tool' | 'user';
  text: string;
  ts?: number;     // seconds since first agent step (for video sync)
  detail?: string; // code content for Write/Edit tools
}

export interface ExtractedTrajectory {
  steps: TrajectoryStep[];
  firstStepAt?: string;
}

function truncateLines(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split('\n');
  let result = lines.slice(0, maxLines).join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars);
  if (lines.length > maxLines || text.length > maxChars) result += '\n...';
  return result;
}

function extractToolStep(toolCall: any, ts?: number): TrajectoryStep | null {
  const toolName = toolCall?.function_name || 'unknown';
  const args = toolCall?.arguments || {};

  let text = toolName;
  let detail: string | undefined;

  if (toolName === 'Bash' || toolName === 'run_shell_command' || toolName === 'exec_command') {
    const cmd: string = args.command || args.cmd || '';
    const heredocMatch = cmd.match(/^cat\s+<<\s*'?EOF'?\s*>\s*(.+)/);
    if (heredocMatch) {
      const filePath = heredocMatch[1].trim();
      text = `write: ${filePath}`;
      const eofIdx = cmd.lastIndexOf('\nEOF');
      if (eofIdx > 0) {
        const content = cmd.slice(cmd.indexOf('\n') + 1, eofIdx);
        if (content) detail = truncateLines(content, 25, 2000);
      }
    } else {
      text = `bash: ${cmd.slice(0, 300)}`;
    }
  } else if (toolName === 'write_stdin') {
    const chars: string = args.chars || '';
    if (!chars) return null;
    const display = chars.replace(/\x03/g, '^C').replace(/\x04/g, '^D').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    text = `stdin: ${display.slice(0, 300)}`;
  } else if (toolName === 'Write' || toolName === 'write_file') {
    text = `write: ${args.file_path || args.path || ''}`;
    const content = args.content || '';
    if (content) detail = truncateLines(content, 25, 2000);
  } else if (toolName === 'Edit') {
    text = `edit: ${args.file_path || ''}`;
    const newStr = args.new_string || '';
    if (newStr) detail = truncateLines(newStr, 25, 2000);
  } else if (toolName === 'Read' || toolName === 'read_file') {
    text = `read: ${args.file_path || args.path || ''}`;
  }

  return { source: 'tool', text, ...(ts !== undefined ? { ts } : {}), ...(detail ? { detail } : {}) };
}

function parseClaudeTrajectory(traj: any): ExtractedTrajectory {
  const rawSteps = traj.steps || [];
  const steps: TrajectoryStep[] = [];

  let firstTs: number | null = null;
  let firstStepAt: string | undefined;
  for (const step of rawSteps) {
    if (step.timestamp) {
      firstTs = new Date(step.timestamp).getTime();
      firstStepAt = step.timestamp;
      break;
    }
  }

  for (const step of rawSteps) {
    if (step.source !== 'agent') continue;

    const msg: string = step.message || '';
    const toolCalls: any[] = step.tool_calls || [];
    if (!msg && toolCalls.length === 0) continue;

    let ts: number | undefined;
    if (firstTs !== null && step.timestamp) {
      ts = Math.round((new Date(step.timestamp).getTime() - firstTs) / 1000);
    }

    if (msg.startsWith('Executed ')) {
      const tcStep = extractToolStep(toolCalls[0] || { function_name: msg.replace('Executed ', '').split(' ')[0] }, ts);
      if (tcStep) steps.push(tcStep);
    } else {
      if (msg) steps.push({ source: 'agent', text: msg, ...(ts !== undefined ? { ts } : {}) });
      for (const tc of toolCalls) {
        const tcStep = extractToolStep(tc, ts);
        if (tcStep) steps.push(tcStep);
      }
    }
  }

  return { steps: steps.slice(0, 200), firstStepAt };
}

function parseCodexLog(content: string): ExtractedTrajectory {
  const steps: TrajectoryStep[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'item.completed' && entry.item) {
        const item = entry.item;
        if (item.type === 'agent_message' && item.text) {
          steps.push({ source: 'agent', text: item.text });
        } else if (item.type === 'reasoning' && item.text) {
          steps.push({ source: 'agent', text: item.text });
        } else if (item.type === 'command_execution' && item.command) {
          let cmd: string = item.command;
          const bashPrefix = cmd.match(/^\/bin\/\w*sh\s+(-\w+\s+)*/);
          if (bashPrefix) cmd = cmd.slice(bashPrefix[0].length);
          let detail: string | undefined;
          const heredocMatch = cmd.match(/^cat\s+<<\s*'?EOF'?\s*>\s*(.+)/);
          if (heredocMatch) {
            const filePath = heredocMatch[1].trim();
            const eofIdx = cmd.lastIndexOf('\nEOF');
            if (eofIdx > 0) {
              const hContent = cmd.slice(cmd.indexOf('\n') + 1, eofIdx);
              if (hContent) detail = truncateLines(hContent, 25, 2000);
            }
            steps.push({ source: 'tool', text: `write: ${filePath}`, ...(detail ? { detail } : {}) });
          } else {
            steps.push({ source: 'tool', text: `bash: ${cmd.slice(0, 300)}` });
          }
        } else if (item.type === 'file_change') {
          steps.push({ source: 'tool', text: `file_change: ${item.filename || 'unknown'}` });
        }
      }
    } catch {}
  }
  return { steps: steps.slice(0, 200) };
}

function parseOpenCodeLog(content: string): ExtractedTrajectory {
  const steps: TrajectoryStep[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('[kimi-loop]') || line.startsWith('[opencode-loop]')) {
      steps.push({ source: 'agent', text: line });
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'text') {
        const text = entry.part?.content || entry.part?.text || '';
        if (text) steps.push({ source: 'agent', text });
      } else if (entry.type === 'tool_use') {
        const tool = entry.part?.tool || '';
        const input = entry.part?.state?.input || {};
        if (tool === 'bash') {
          steps.push({ source: 'tool', text: `bash: ${input.command || ''}`.slice(0, 200) });
        } else if (tool === 'read') {
          steps.push({ source: 'tool', text: `read: ${input.filePath || ''}` });
        } else if (tool === 'write') {
          steps.push({ source: 'tool', text: `write: ${input.filePath || ''}` });
        } else if (tool) {
          steps.push({ source: 'tool', text: tool });
        }
      }
    } catch {}
  }
  return { steps: steps.slice(0, 200) };
}

function parseGeminiCliLog(content: string): ExtractedTrajectory {
  const steps: TrajectoryStep[] = [];
  const lines = content.split('\n');

  let inBashBlock = false;
  let bashFileName = '';
  let bashCodeLines: string[] = [];
  let inSyntaxErrors = false;

  function flushBashBlock() {
    if (!bashFileName && bashCodeLines.length === 0) return;
    const label = bashFileName ? `write: ${bashFileName}` : 'bash';
    let detail: string | undefined;
    if (bashCodeLines.length > 0) {
      detail = truncateLines(bashCodeLines.join('\n'), 25, 2000);
    }
    steps.push({ source: 'tool', text: label, ...(detail ? { detail } : {}) });
    bashFileName = '';
    bashCodeLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('Bash command parsing error detected')) {
      flushBashBlock();
      inBashBlock = true;
      inSyntaxErrors = false;
      const fileMatch = trimmed.match(/> ([\w/./-]+\.\w+)$/);
      bashFileName = fileMatch ? fileMatch[1] : '';
      continue;
    }
    if (inBashBlock) {
      if (trimmed.startsWith('EOF Syntax Errors:') || trimmed === 'EOF Syntax Errors: [') {
        inSyntaxErrors = true;
        continue;
      }
      if (inSyntaxErrors) {
        if (trimmed === ']') {
          inSyntaxErrors = false;
          inBashBlock = false;
          flushBashBlock();
        }
        continue;
      }
      if (trimmed === 'EOF') continue;
      bashCodeLines.push(line);
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith('YOLO mode is enabled')) continue;
    if (trimmed.startsWith('[agent-loop]')) continue;
    if (trimmed.startsWith('missing pgrep output')) continue;
    steps.push({ source: 'agent', text: trimmed });
  }

  flushBashBlock();
  return { steps: steps.slice(0, 200) };
}

/** Try each known trajectory format in order. */
export function extractTrajectoryFromTrial(trialDir: string): ExtractedTrajectory | null {
  const agentDir = join(trialDir, 'agent');
  if (!existsSync(agentDir)) return null;

  // ATIF-formatted trajectory.json (Claude Code, OpenCode adapter)
  const trajectoryPath = join(agentDir, 'trajectory.json');
  if (existsSync(trajectoryPath)) {
    try {
      return parseClaudeTrajectory(JSON.parse(readFileSync(trajectoryPath, 'utf-8')));
    } catch {}
  }

  const codexPath = join(agentDir, 'codex.txt');
  if (existsSync(codexPath)) {
    try { return parseCodexLog(readFileSync(codexPath, 'utf-8')); } catch {}
  }

  try {
    const agentFiles = readdirSync(agentDir);
    const opencodePath = agentFiles.find(f => f.startsWith('opencode') && f.endsWith('.txt'));
    if (opencodePath) {
      try { return parseOpenCodeLog(readFileSync(join(agentDir, opencodePath), 'utf-8')); } catch {}
    }
  } catch {}

  const geminiPath = join(agentDir, 'gemini-cli.txt');
  if (existsSync(geminiPath)) {
    try { return parseGeminiCliLog(readFileSync(geminiPath, 'utf-8')); } catch {}
  }

  return null;
}
