export const meta = {
  name: 'magic-xp-study',
  description: 'Analyze 30m Magic XP runs across top models to explain why Opus 4.8 tops the peak-rate metric: artifact vs strategy vs execution',
  phases: [
    { title: 'Trace', detail: 'per-model: analyze 15s XP sample curve + flag measurement artifacts' },
    { title: 'Strategy', detail: 'per-model: read transcript, extract strategy, reconcile with the curve' },
    { title: 'Synthesize', detail: 'cross-model verdict on the peak-rate metric and Opus 4.8' },
  ],
}

// Focus models for the 30m Magic comparison. Each has a precomputed sample-series
// file at analysis/magic-study/<key>.json (includes the transcript path).
const MODELS = [
  { key: 'opus48',        name: 'Opus 4.8 (SUBJECT — headline peak 130, final 15000)' },
  { key: 'opus48-max',    name: 'Opus 4.8 max-thinking (final only 2000 — why so bad?)' },
  { key: 'opus',          name: 'Opus 4.6 (final 22800, peak 100)' },
  { key: 'codex53',       name: 'GPT-5.3-codex (REAL WINNER by final XP 36475, peak 90)' },
  { key: 'opus47',        name: 'Opus 4.7 (final only 3650 — 4.8 predecessor)' },
  { key: 'gemini35flash', name: 'Gemini 3.5 Flash (final 18200, highest SUSTAINED smooth60=64)' },
]

const TRACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'curveShape', 'peakIsArtifact', 'peakExplanation', 'activeWindows', 'flatWindows', 'biggestLumpXp', 'sustainedVsPeak', 'anomalies'],
  properties: {
    model: { type: 'string' },
    curveShape: { type: 'string', enum: ['steady-climb', 'step-function-few-lumps', 'burst-then-flat', 'late-start', 'mostly-flat-zero'], description: 'overall shape of the magic-XP-over-time curve' },
    peakIsArtifact: { type: 'boolean', description: 'true if the headline peakXpRate is driven by a single lumpy 15s window rather than a sustained rate' },
    peakExplanation: { type: 'string', description: 'why the headline peak is what it is; compare headlinePeakXpRate vs smoothedPeak60s' },
    activeWindows: { type: 'integer' },
    flatWindows: { type: 'integer' },
    biggestLumpXp: { type: 'integer', description: 'magic XP delta in the single largest 15s window' },
    sustainedVsPeak: { type: 'string', description: 'ratio/comparison of smoothed-60s sustained rate to the headline single-window peak' },
    anomalies: { type: 'array', items: { type: 'string' }, description: 'negative-XP windows, suspicious gaps, level-up timing, tracker oddities' },
  },
}

const STRAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'trainingMethod', 'spellOrAction', 'setupSteps', 'timeToFirstCastSec', 'idleVsActing', 'reconcilesWithCurve', 'lumpinessSource', 'errorsOrStalls', 'narrationLevel', 'strategyQuality', 'notes'],
  properties: {
    model: { type: 'string' },
    trainingMethod: { type: 'string', description: 'high-level method, e.g. combat spell on monster / alchemy / enchant / curse / superheat' },
    spellOrAction: { type: 'string', description: 'specific spell(s) and target/items used to gain magic XP' },
    setupSteps: { type: 'array', items: { type: 'string' }, description: 'runes/gear/banking/travel setup the agent did before training' },
    timeToFirstCastSec: { type: 'integer', description: 'approx seconds before the first actual XP-granting cast; -1 if never' },
    idleVsActing: { type: 'string', description: 'CRITICAL: was the agent genuinely idle during the flat windows, or was it acting but the tracker credited XP in lumps? cite transcript evidence' },
    reconcilesWithCurve: { type: 'boolean', description: 'does the transcript explain the flat/active window pattern from the Trace phase?' },
    lumpinessSource: { type: 'string', enum: ['agent-idle-between-bursts', 'batched-action-grants-xp-in-chunks', 'tracker-sampling-batching', 'continuous-casting-smooth', 'unknown'], description: 'root cause of the XP-curve lumpiness' },
    errorsOrStalls: { type: 'array', items: { type: 'string' }, description: 'crashes, stuck loops, failed actions, long pauses' },
    narrationLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'how much the agent narrated/planned vs acted' },
    strategyQuality: { type: 'string', enum: ['excellent', 'good', 'mediocre', 'poor'], description: 'judgement of the chosen strategy for maximizing magic XP' },
    notes: { type: 'string' },
  },
}

phase('Trace')

const results = await pipeline(
  MODELS,
  // Stage 1: measurement / curve analysis from the precomputed series
  (m) => agent(
    `You are analyzing the MAGIC-XP 30-minute benchmark run for model "${m.key}" (${m.name}).

Read the precomputed sample series at: analysis/magic-study/${m.key}.json

That file contains:
- headlinePeakXpRate: the leaderboard metric = MAX magic-XP delta over ANY single 15-second sampling window (converted to real-game XP/min via /8/25).
- smoothedPeak60s: the same metric computed over 60s (4-window) spans — a proxy for SUSTAINED rate.
- peakWindow: the single window that produced the headline peak.
- series[]: every 15s window with {tSec, magicXp(cumulative), lvl, dXp(delta this window), dMs, ratePerMin}.
- activeWindows / flatWindows / negativeWindows counts, firstXpAtSec.

The sampling interval is 15000ms (SAMPLE_INTERVAL_MS). The benchmark question: Opus 4.8 tops the headline peakXpRate (130) for magic but is only mid-pack on final XP (15000, 5th). Is that headline "win" a real burst of skilled play, or an ARTIFACT of lumpy XP crediting measured over coarse 15s windows?

Analyze the curve. Determine: how many windows actually gained XP, how concentrated the gains are (is most XP delivered in a few big lumps?), how the headline single-window peak compares to the 60s-smoothed sustained rate, and whether the headline peak is an artifact of one lumpy window. Note any anomalies (negative deltas, level-up jumps, suspicious gaps).

Return ONLY the structured object.`,
    { label: `trace:${m.key}`, phase: 'Trace', schema: TRACE_SCHEMA }
  ),
  // Stage 2: strategy from the transcript, reconciled against the curve
  (trace, m) => agent(
    `You are analyzing the agent TRANSCRIPT for the MAGIC-XP 30-minute run of model "${m.key}" (${m.name}).

The transcript path is the "transcript" field in analysis/magic-study/${m.key}.json (a large 0.5–1.2MB text log of the agent's tool calls and reasoning). DO NOT read it whole. Instead:
- First read analysis/magic-study/${m.key}.json for the XP-curve facts.
- Then use Bash (grep -n / sed -n ranges, wc -l) on the transcript to locate and sample: spell casting, rune/gear setup, banking, travel, monster/target selection, errors, long idle stretches, and how the agent describes its plan. Sample the beginning (setup), middle, and end.

The Trace phase found this about the XP curve for ${m.key}:
${JSON.stringify(trace)}

KEY QUESTION to resolve from the transcript: the curve shows ${trace?.activeWindows ?? '?'} active vs ${trace?.flatWindows ?? '?'} flat 15s windows. Was the agent GENUINELY IDLE during the flat windows (planning/narrating/stuck), or was it continuously casting but the magic XP was only CREDITED IN LUMPS (e.g. an action that batches XP, or the tracker reading magic XP intermittently)? Cite specific transcript evidence (timestamps / tool calls) to decide lumpinessSource.

Also extract the training method, specific spell, setup steps, time to first cast, error/stalls, narration level, and judge strategy quality.

Return ONLY the structured object.`,
    { label: `strategy:${m.key}`, phase: 'Strategy', schema: STRAT_SCHEMA }
  ).then(strat => ({ model: m.key, name: m.name, trace, strat }))
)

phase('Synthesize')

const clean = results.filter(Boolean)

const verdict = await agent(
  `You are writing the final analysis for a RuneScape AI benchmark question.

CONTEXT: In the 30-minute Magic-XP benchmark, the leaderboard's headline metric is "peakXpRate" = the maximum magic-XP gained in ANY single 15-second sampling window (rescaled to real-game XP/min). Opus 4.8 ("opus48") tops this metric for Magic at 130 XP/min, yet ranks only 5th on FINAL XP (15000). The user suspects Opus 4.8's strategy wasn't actually good and that the apparent win is an execution detail or a measurement artifact of the coarse 15s sampling.

Here are the per-model findings (Trace = XP-curve/measurement analysis; Strategy = transcript analysis):
${JSON.stringify(clean, null, 1)}

Reference numbers (30m magic): opus48 final=15000 peak=130 smooth60=43 active=5/119; opus48-max final=2000; opus(4.6) final=22800 peak=100 smooth60=42 active=18; codex53 final=36475 peak=90 smooth60=55 active=19; opus47(4.7) final=3650; gemini35flash final=18200 smooth60=64 active=10.

Write a decisive, evidence-based report (markdown) answering:
1. Does Opus 4.8 actually "win" Magic? By which metric, and is that metric meaningful?
2. Is the peakXpRate=130 a real burst of skilled play or an ARTIFACT of lumpy XP crediting over 15s windows? Use the active-window counts and smoothed-vs-peak comparison across models as evidence.
3. What is the ROOT CAUSE of opus48's lumpy curve (agent idle / batched action / tracker batching)? Did the transcripts confirm it?
4. Was Opus 4.8's actual STRATEGY good, mediocre, or poor compared to codex53/opus(4.6)/gemini35flash? Why did 4.8 (15000) beat 4.7 (3650) but lose to 4.6 (22800)?
5. Concrete recommendation: should the leaderboard keep single-window peakXpRate as the headline metric, or switch to final XP / a smoothed/sustained rate? What would the magic ranking look like under each?

Be specific and quantitative. Flag clearly if peakXpRate is a flawed metric.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { verdict, perModel: clean }
