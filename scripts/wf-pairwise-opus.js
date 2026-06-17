export const meta = {
  name: 'pairwise-opus-48-vs-47',
  description: 'Deeply analyze Opus 4.8 vs 4.7 skill trajectories: per-skill subjective comparison then synthesis',
  phases: [
    { title: 'Per-skill analysis', detail: 'one analyst per skill reads both transcripts + quant' },
    { title: 'Synthesis', detail: 'cross-cutting subjective + quantitative report' },
  ],
}

const T = '/Users/max/workplace/rs-bench2/analysis/pairwise/transcripts'
const QUANT = '/Users/max/workplace/rs-bench2/analysis/pairwise/quant.json'

// skill -> [reward_48, reward_47_best]
const REWARDS = {
  attack: [188, 138], cooking: [428, 285], crafting: [21, 150], defence: [112, 140],
  firemaking: [340, 600], fishing: [585, 820], fletching: [313, 337], hitpoints: [27, 65],
  magic: [34, 44], mining: [0, 375], prayer: [63, 61], ranged: [56, 158],
  smithing: [0, 100], strength: [244, 162], thieving: [336, 2316], woodcutting: [488, 540],
}
// 4.7 mean across 4 runs (context: the best run is the exemplar, mean shows typical)
const MEAN47 = {
  attack: 94.5, cooking: 161.2, crafting: 50.2, defence: 89.5, firemaking: 412.5,
  fishing: 567.5, fletching: 200.7, hitpoints: 51.5, magic: 38.5, mining: 299.5,
  prayer: 46.8, ranged: 93, smithing: 60, strength: 105.5, thieving: 1096.5, woodcutting: 321,
}

const SKILLS = Object.keys(REWARDS)

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['skill', 'verdict', 'severity', 'strategy_48', 'strategy_47', 'root_cause',
    'time_allocation', 'tool_behavior', 'recovery', 'anecdotes', 'quant_signals'],
  properties: {
    skill: { type: 'string' },
    verdict: { type: 'string', enum: ['4.8 much better', '4.8 better', 'similar', '4.7 better', '4.7 much better'] },
    severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'how illuminating this case is for understanding the 4.8 regression' },
    strategy_48: { type: 'string', description: 'what concrete strategy/approach 4.8 took and how it evolved over the 30 min' },
    strategy_47: { type: 'string', description: 'what concrete strategy/approach 4.7 took' },
    root_cause: { type: 'string', description: 'the specific reason for the score difference — be concrete and mechanistic, cite what happened in the transcript' },
    time_allocation: { type: 'string', description: 'how each model spent the 30 minutes: exploration vs exploitation, when it locked onto a working loop, how much time wasted on dead ends/debugging' },
    tool_behavior: { type: 'string', description: 'notable differences in tool usage: # execute_code vs bash, files read, over-engineering (writing scripts/files), verbosity' },
    recovery: { type: 'string', description: 'how each handled errors, stalls, stale state, "cant reach" etc — persistence vs giving up vs thrashing' },
    anecdotes: { type: 'array', items: { type: 'string' }, description: '2-5 short near-verbatim quotes from the visible text blocks (💬) that reveal tone, confidence, frustration, persistence, self-correction, or notable reasoning. Prefer 4.8 quotes but include 4.7 for contrast. Note which model.' },
    quant_signals: { type: 'string', description: 'concrete numbers from the header/quant that support the story (steps, exec_code, bash, text_blocks, output_tokens, when it stopped)' },
  },
}

phase('Per-skill analysis')
const findings = await parallel(SKILLS.map((skill) => async () => {
  const [r48, r47] = REWARDS[skill]
  const prompt = `You are a meticulous AI-behavior analyst comparing two Claude models on a RuneScape XP-training benchmark.
Each agent had 30 minutes to maximize PEAK XP/min for the **${skill}** skill, controlling a bot via an MCP \`execute_code\` tool (writes JS game code) plus normal Bash/Read/Write tools. Higher reward = better.

SCORES for ${skill}: Opus 4.8 = ${r48} | Opus 4.7 (best of 4 runs) = ${r47} | Opus 4.7 (mean of 4 runs) = ${MEAN47[skill]}

Read BOTH transcripts carefully (they include a header with quant stats, then a chronological transcript: 💬=visible model text, 🟢=execute_code game code, \$=bash, 📖=read, ✏️=write, ←=tool result, and any AGENT-WRITTEN MEMORY at the end):
- Opus 4.8: ${T}/opus48-${skill}.md
- Opus 4.7: ${T}/opus47-${skill}.md

Analyze how the two models BEHAVE DIFFERENTLY. Be concrete and cite what actually happened. Cover: strategy & how it evolved, how the 30 min was spent (explore vs exploit, time lost to dead-ends/debugging), tool-use patterns (verbosity, over-engineering, files), error recovery / persistence vs thrashing, and pull notable text-block quotes that reveal tone/emotion/reasoning.
Be even-handed: where 4.8 is BETTER, say why; where 4.8 is WORSE, diagnose the mechanism. The overarching question is WHY 4.8 underperforms 4.7 on average despite winning some skills.`
  return agent(prompt, { label: `analyze:${skill}`, phase: 'Per-skill analysis', schema: FINDING_SCHEMA })
}))

const valid = findings.filter(Boolean)
log(`Analyzed ${valid.length}/${SKILLS.length} skills`)

phase('Synthesis')
const synthPrompt = `You are the lead analyst writing the final report on why Claude **Opus 4.8 underperforms Opus 4.7** on the RuneScape skill-training benchmark, despite winning several individual skills.

You have ${valid.length} per-skill structured findings (below) and a quant dataset at ${QUANT} (read it — it has per-trajectory: total_steps, n_execute_code, n_bash, n_read/write, agent_exec_min, output tokens, text_blocks, check_rate_calls, files_touched, rate_samples). Also re-read any specific transcripts in ${T}/ if you need to confirm a claim.

PER-SKILL FINDINGS (JSON):
${JSON.stringify(valid, null, 2)}

Write a thorough markdown report with these sections:

## 1. Headline
The 2-3 sentence story of how 4.8 behaves differently and why it scores lower on average.

## 2. Behavioral differences (subjective)
The cross-cutting STRATEGY and PERSONALITY differences. Synthesize patterns that recur across skills — e.g. exploration vs exploitation, over-engineering, verbosity/narration, persistence vs thrashing, premature giving-up, locking onto a loop early vs late. Use concrete per-skill evidence.

## 3. Failure mode deep-dives
Walk through the most illuminating cases (especially mining=0, smithing=0, thieving collapse 336 vs 2316, ranged, crafting, hitpoints) — mechanistically, what went wrong for 4.8 that 4.7 avoided.

## 4. Where 4.8 is genuinely better
Cooking, woodcutting, strength, attack, fletching — what did 4.8 do RIGHT? Is the regression a real capability loss or a behavioral/calibration shift (e.g. higher variance, worse stopping decisions)?

## 5. Thinking patterns & emotional anecdotes
The most interesting verbatim quotes showing tone, confidence, frustration, self-doubt, persistence, or notable reasoning. Contrast 4.8's voice vs 4.7's.

## 6. Quantitative comparison (informed by the above)
Propose and describe the metrics that best CAPTURE the behavioral differences you found (e.g. steps/min, execute_code count, bash exploration, text_blocks as a verbosity proxy, time-to-first-nonzero, output tokens, how early it stopped). Describe the direction and magnitude of each. Do NOT fabricate exact aggregate numbers — describe the patterns and which metrics matter; the orchestrator will compute exact tables. Reference specific quant.json values where you cite them.

## 7. Hypotheses for the regression
2-4 concrete, falsifiable hypotheses about what changed in 4.8's policy that hurts this benchmark.

Be rigorous, specific, and cite skills/numbers. This report is for the model developer.`

const report = await agent(synthPrompt, { label: 'synthesis', phase: 'Synthesis' })

return { report, findings: valid }
