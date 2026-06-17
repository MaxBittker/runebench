export const meta = {
  name: 'pairwise-opus-v2-neutral',
  description: 'Neutral per-skill 4.8 vs 4.7 (default thinking) behavior->outcome analysis, against full 4.7 variance',
  phases: [
    { title: 'Per-skill analysis', detail: 'one analyst per skill: 4.8 run vs 4.7 median+best, attribute score delta to behavior' },
    { title: 'Synthesis', detail: 'cluster behaviors that raise vs lower score; locate 4.8 on each' },
  ],
}

const T = '/Users/max/workplace/rs-bench2/analysis/pairwise2/transcripts'
const QUANT = '/Users/max/workplace/rs-bench2/analysis/pairwise2/quant.json'

const DIST = [{"skill":"attack","r48":188,"min":0,"med":88,"mean":78.7,"max":138,"sd":44.9,"runs":[0,44,88,94,108,138],"verdict":"above 4.7 range"},{"skill":"defence","r48":112,"min":0,"med":42,"mean":66.7,"max":140,"sd":46,"runs":[0,40,42,72,106,140],"verdict":"within 4.7 range"},{"skill":"strength","r48":244,"min":0,"med":64,"mean":79.7,"max":162,"sd":49.3,"runs":[0,56,64,96,100,162],"verdict":"above 4.7 range"},{"skill":"hitpoints","r48":27,"min":0,"med":48,"mean":45.8,"max":69,"sd":23.4,"runs":[0,35,48,58,65,69],"verdict":"within 4.7 range"},{"skill":"ranged","r48":56,"min":0,"med":74,"mean":75.7,"max":158,"sd":56.1,"runs":[0,14,74,82,126,158],"verdict":"within 4.7 range"},{"skill":"prayer","r48":63,"min":0,"med":56,"mean":41,"max":61,"sd":24.4,"runs":[0,14,56,56,59,61],"verdict":"above 4.7 range"},{"skill":"magic","r48":34,"min":0,"med":36,"mean":33.5,"max":47,"sd":15.6,"runs":[0,34,36,40,44,47],"verdict":"within 4.7 range"},{"skill":"woodcutting","r48":488,"min":0,"med":200,"mean":253.5,"max":540,"sd":173.2,"runs":[0,150,200,237,394,540],"verdict":"within 4.7 range"},{"skill":"fishing","r48":585,"min":0,"med":415,"mean":402.5,"max":820,"sd":272.2,"runs":[0,145,415,430,605,820],"verdict":"within 4.7 range"},{"skill":"mining","r48":0,"min":0,"med":298,"mean":255.2,"max":375,"sd":130.9,"runs":[0,175,298,333,350,375],"verdict":"within 4.7 range"},{"skill":"cooking","r48":428,"min":0,"med":120,"mean":135,"max":285,"sd":90.8,"runs":[0,60,120,165,180,285],"verdict":"above 4.7 range"},{"skill":"fletching","r48":313,"min":0,"med":135,"mean":167.8,"max":337,"sd":113.2,"runs":[0,130,135,237,337],"verdict":"within 4.7 range"},{"skill":"crafting","r48":21,"min":0,"med":14,"mean":35.8,"max":150,"sd":52,"runs":[0,1,14,25,25,150],"verdict":"within 4.7 range"},{"skill":"smithing","r48":0,"min":0,"med":37,"mean":53,"max":100,"sd":34.2,"runs":[0,28,37,75,78,100],"verdict":"within 4.7 range"},{"skill":"firemaking","r48":340,"min":0,"med":300,"mean":335,"max":600,"sd":193.2,"runs":[0,240,300,360,510,600],"verdict":"within 4.7 range"},{"skill":"thieving","r48":336,"min":0,"med":352,"mean":789.7,"max":2316,"sd":807.3,"runs":[0,232,352,460,1378,2316],"verdict":"within 4.7 range"}]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['skill', 'classification', 'score_summary', 'what_drives_score', 'behavior_diff', 'drivers', 'within_noise', 'anecdotes'],
  properties: {
    skill: { type: 'string' },
    classification: { type: 'string', enum: ['4.8 clearly better', '4.8 mildly better', 'indistinguishable (within 4.7 noise)', '4.8 mildly worse', '4.8 clearly worse'] },
    score_summary: { type: 'string', description: 'where 4.8 sits relative to the 4.7 run-to-run distribution (cite the numbers)' },
    what_drives_score: { type: 'string', description: 'for THIS skill, the 1-3 behavioral/strategic factors that separate high-scoring from low-scoring runs (observed across the 4.8 + 4.7 runs you can see). This is the causal model.' },
    behavior_diff: { type: 'string', description: 'concrete behavioral differences between the 4.8 run and the 4.7 run(s): strategy chosen, exploration vs exploitation, tooling (in-band execute_code vs background scripts), reading docs, verbosity, when it locked in, recovery' },
    drivers: {
      type: 'array', description: 'the specific behaviors that moved 4.8 UP or DOWN vs the 4.7 comparison, each tagged with direction',
      items: { type: 'object', additionalProperties: false, required: ['behavior', 'direction', 'evidence'],
        properties: {
          behavior: { type: 'string', description: 'short name of the behavior, e.g. "climbed value ladder", "ran background script", "read shipped docs", "atomic single-call burst", "optimized loop cadence on low-value target"' },
          direction: { type: 'string', enum: ['raised 4.8', 'lowered 4.8', 'neutral'] },
          evidence: { type: 'string', description: 'what in the transcript shows this and its score effect' },
        } } },
    within_noise: { type: 'boolean', description: 'true if the 4.8-vs-4.7 score difference is plausibly just run-to-run variance (4.8 inside 4.7 range AND no decisive behavioral difference), false if a real behavioral difference drove a real gap' },
    anecdotes: { type: 'array', items: { type: 'string' }, description: '1-4 short near-verbatim quotes (label model) revealing the decisive reasoning/strategy choice, in either direction' },
  },
}

phase('Per-skill analysis')
const findings = await parallel(DIST.map((d) => async () => {
  const best = `${T}/opus47-${d.skill}-best.md`
  const med = `${T}/opus47-${d.skill}-median.md`
  const prompt = `You are a NEUTRAL AI-behavior analyst comparing two Claude models (Opus 4.8 vs Opus 4.7, BOTH default thinking) on one RuneScape XP-rate task: **${d.skill}**. 30 min, maximize PEAK XP/min, control a bot via MCP \`execute_code\` (writes JS game code) + Bash/Read/Write.

DO NOT assume either model is better. Your job is to explain what BEHAVIOR drove the score difference, in whichever direction it goes — and to judge honestly whether the difference is even real or just run-to-run noise.

CRITICAL CONTEXT — 4.7's own run-to-run variance on ${d.skill} (it was run 5-6 times): runs sorted = ${JSON.stringify(d.runs)}; min=${d.min} median=${d.med} mean=${d.mean} max=${d.max} sd=${d.sd}. Opus 4.8 (a SINGLE run) scored ${d.r48} → it sits **${d.verdict}**. Note 4.7 fails (scores 0) on roughly 1 in 6 runs of EVERY skill, so a single low score is not necessarily a model difference.

Read these transcripts (header has quant stats; 💬=visible model text, 🟢=game code, \$=bash, 📖=read, ✏️=write, 🔌=disconnect, ←=result; AGENT MEMORY at end if present):
- Opus 4.8 (the one run): ${T}/opus48-${d.skill}-run.md
- Opus 4.7 BEST run (${d.max}): ${best}
- Opus 4.7 MEDIAN run (${d.med}): ${med}   (if this file is missing, the best run was also the median; just use best)
Optionally consult ${QUANT} for the other 4.7 runs' quant rows.

First build a causal model: for THIS skill, what 1-3 behaviors separate a high-scoring run from a low-scoring one? Then locate 4.8 and the 4.7 runs on those behaviors, and attribute 4.8's outcome (up/down/same vs 4.7) to specific behaviors. Be even-handed: credit 4.8 where it's better, diagnose where it's worse, and explicitly flag when the gap is within noise.`
  return agent(prompt, { label: `analyze:${d.skill}`, phase: 'Per-skill analysis', schema: SCHEMA })
}))

const valid = findings.filter(Boolean)
log(`Analyzed ${valid.length}/16 skills`)

phase('Synthesis')
const synth = await agent(`You are the lead analyst. We are NO LONGER assuming Opus 4.8 is worse than 4.7 — the data does not support that: across 16 default-thinking skill tasks, 4.8 (single run each) lands ABOVE 4.7's entire 5-6-run range on 4 skills (attack, strength, prayer, cooking), WITHIN 4.7's range on the other 12, and BELOW 4.7's range on NONE. 4.7 itself scores 0 on ~1/6 runs of every skill. So model-vs-model score gaps are mostly swamped by behavioral run-to-run variance.

Your task: explain the DIFFERENCES IN BEHAVIOR that produce positive vs negative score changes, using the ${valid.length} per-skill findings (JSON below) and the quant at ${QUANT} (per-run: total_steps, n_execute_code, n_bash, n_read, n_write, n_disconnect, bg_script, reads_app_docs, text_blocks, out_tokens, agent_exec_min, stopped_early). Read quant.json to ground claims.

PER-SKILL FINDINGS:
${JSON.stringify(valid, null, 2)}

Write a markdown report:

## 1. Verdict on "is 4.8 worse?"
State plainly that it is not substantiated, with the distribution evidence. Characterize 4.8's profile vs 4.7 honestly (e.g. higher mean on combat/cook, higher or lower variance, etc.).

## 2. Behaviors that RAISE score (and whether 4.8 does more/less of them)
Cluster the positive drivers across skills (e.g. climbing the XP-per-action value ladder, atomic single-call bursts, reading shipped /app docs, staying in-band, committing to a production loop early, exploiting peak-is-a-max). For each: which skills it showed up in, and whether 4.8 or 4.7 tends to do it more.

## 3. Behaviors that LOWER score (same treatment)
Cluster the negative drivers (e.g. optimizing loop cadence on a low-value target, background-script two-controller conflict + ENOSPC, false-ceiling coasting, not reading docs, abandoning on a wrong premise, dying/losing items). Which skills, and 4.8 vs 4.7 tendency.

## 4. Where 4.8's behavior genuinely changed the outcome (signal, not noise)
The skills where a real behavioral difference drove a real gap in EITHER direction (use the within_noise flags). Separate these from the within-noise ties.

## 5. 4.8's distinctive behavioral signature
What 4.8 reliably does differently regardless of score (e.g. ~4x more narration/text_blocks, deeper mechanistic insight, more deliberation). Note which of these are score-relevant vs cosmetic.

## 6. Net behavioral takeaways
3-6 crisp statements about which behavioral shifts helped 4.8 and which hurt it, and what a 4.8 that kept its strengths but dropped its score-lowering habits would look like.

Be rigorous and symmetric. Cite skills and numbers. Lead with behavior, not model identity.`, { label: 'synthesis', phase: 'Synthesis' })

return { synth, findings: valid }
