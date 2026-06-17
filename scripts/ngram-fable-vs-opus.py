#!/usr/bin/env python3
"""Focused fable-vs-opus n-gram comparison (same claude-code harness => clean).
Prior: fable is the stronger model; goal is to show the n-gram patterns that
characterize *why*. Emits ratio tables to analysis/ngram/fable-vs-opus.data.txt.
"""
import json, re, glob
from collections import Counter

JOBS = "/Users/max/workplace/rs-bench2/jobs"

def extract(path):
    out = []
    for line in open(path, errors="ignore"):
        line = line.strip()
        if not line.startswith("{"): continue
        try: o = json.loads(line)
        except: continue
        if o.get("type") != "assistant": continue
        m = o.get("message", {})
        if m.get("model") == "<synthetic>": continue
        for b in m.get("content", []):
            if b.get("type") == "text":
                out.append(b.get("text", ""))
    return "\n".join(out)

def skill_of(p):
    for part in p.split("/"):
        if "-xp-" in part and "__" in part: return part.split("-xp-")[0]
    return "?"

def corpus(pat):
    best = {}
    for f in glob.glob(pat):
        t = extract(f).replace("’", "'")
        s = skill_of(f)
        if s not in best or len(t) > len(best[s]): best[s] = t
    return best  # skill -> text

fable = corpus(f"{JOBS}/skills-30m-fable-2026*/*/agent/claude-code.txt")
opus  = corpus(f"{JOBS}/skills-30m-opus48-2026*/*/agent/claude-code.txt")
F = "\n".join(fable.values()); O = "\n".join(opus.values())

WORD = re.compile(r"[a-z][a-z']*")
tF, tO = WORD.findall(F.lower()), WORD.findall(O.lower())
nF, nO = len(tF), len(tO)

def per1k(text, rx):  # rate per 1000 tokens
    n = len(tF) if text is F else len(tO)
    return len(re.findall(rx, text.lower())) * 1000 / max(1, n)

out = []
def p(s=""): out.append(s)

p(f"FABLE corpus: {len(fable)} skills, {nF} narration tokens, {len(set(tF))} unique")
p(f"OPUS  corpus: {len(opus)} skills, {nO} narration tokens, {len(set(tO))} unique")
p(f"Narration words per skill:  fable {nF/len(fable):.0f}   opus {nO/len(opus):.0f}   "
  f"(opus narrates {nO/len(opus)/(nF/len(fable)):.1f}x more)")
p()

# ---- 1. measurement / numeric register --------------------------------------
NUM = {
 "any digit in prose":     r"\d",
 "compact magnitude (12k,72k)": r"\b\d+\.?\d*\s*k\b",
 "multiplier (25x, 7.6x)": r"\b\d+\.?\d*\s*x\b|\bx\d+\b",
 "before->after delta":    r"->|→|\bfrom .{0,14}\bto\b|\d+\s*[-–]\s*>\s*\d+",
 "explicit level (level N)": r"\blevel \d|\blvl \d",
 "per-unit (per/each/every)": r"\bper\b|\beach\b|\bevery\b",
 "rate (xp/min, /s)":      r"xp\s*/?\s*(min|sec|s\b)|/\s*(min|s)\b|per (min|second)",
}
p("## 1. MEASUREMENT / NUMERIC register  (per 1,000 narration tokens)")
p(f"{'marker':<30s}{'fable':>8s}{'opus':>8s}{'fable/opus':>12s}")
for k, rx in NUM.items():
    a, b = per1k(F, rx), per1k(O, rx)
    p(f"{k:<30s}{a:8.2f}{b:8.2f}{(a/b if b else 0):>11.1f}x")
p()

# ---- 2. abstract vs concrete quant -----------------------------------------
p("## 2. ABSTRACT quant words (opus leans here) (per 1,000 tokens)")
ABS = {
 "abstract math word (rate/ratio/optimize/...)": r"\b(rate|ratio|calcul|optimiz|multipl|divid|average|avg|project|extrapolat)",
 "vague comparative (faster/better/...)": r"\b(more|fewer|less|higher|lower|faster|slower|better)\b",
}
p(f"{'marker':<46s}{'fable':>7s}{'opus':>7s}{'opus/fable':>12s}")
for k, rx in ABS.items():
    a, b = per1k(F, rx), per1k(O, rx)
    p(f"{k:<46s}{a:7.2f}{b:7.2f}{(b/a if a else 0):>11.1f}x")
p()

# ---- 3. scorer reverse-engineering vocabulary ------------------------------
p("## 3. SCORER / OBJECTIVE-FUNCTION vocabulary (per 1,000 tokens)")
SCO = {
 "window (15s/sample window)":  r"\bwindow|\bsample",
 "baseline":                    r"\bbaseline",
 "peak":                        r"\bpeak",
 "normalized / real-game":      r"\bnormaliz|real-?game|real xp",
 "tracker/scorer/checker":      r"\btracker|\bscorer|\bchecker|check_xp",
 "burst":                       r"\bburst",
 "align(ed/ment)":              r"\balign",
}
p(f"{'marker':<32s}{'fable':>8s}{'opus':>8s}{'fable/opus':>12s}")
for k, rx in SCO.items():
    a, b = per1k(F, rx), per1k(O, rx)
    p(f"{k:<32s}{a:8.2f}{b:8.2f}{(a/b if b else float('inf')):>11.1f}x")
p()

# ---- 4. action-verb temperament --------------------------------------------
p("## 4. ACTION / TEMPO temperament (per 1,000 tokens)")
ACT = {
 "let me <verb> (imperative)": r"\blet me\b",
 "start immediately":          r"\bimmediat",
 "min/minutes left (clock)":   r"\bmin(ute)?s? (left|remaining)\b",
 "clean/gapless/tight loop":   r"\b(gapless|clean loop|a clean|tighter|tight)\b",
 "verify/confirm":             r"\b(verify|confirm)\b",
 "! exclamation":              r"!",
}
p(f"{'marker':<30s}{'fable':>8s}{'opus':>8s}{'opus/fable':>12s}")
for k, rx in ACT.items():
    a, b = per1k(F, rx), per1k(O, rx)
    p(f"{k:<30s}{a:8.2f}{b:8.2f}{(b/a if a else float('inf')):>11.1f}x")
p()

# ---- 5. distinctive bigrams/trigrams (raw counts, exclusive) ---------------
def grams(toks, n): return Counter(" ".join(toks[i:i+n]) for i in range(len(toks)-n+1))
def exclusive(a_toks, b_toks, n, topk=16, minc=5):
    ca, cb = grams(a_toks, n), grams(b_toks, n)
    rows = [(c, g) for g, c in ca.items() if c >= minc and cb.get(g, 0) == 0]
    rows.sort(reverse=True)
    return rows[:topk]
for n, lab in [(2, "bigrams"), (3, "trigrams")]:
    p(f"## 5{'.' if n==2 else '+'} {lab} used by ONE model only (count >=5, 0 in the other)")
    p(f"-- FABLE-only {lab} --")
    for c, g in exclusive(tF, tO, n): p(f"   {c:3d}  {g}")
    p(f"-- OPUS-only {lab} --")
    for c, g in exclusive(tO, tF, n): p(f"   {c:3d}  {g}")
    p()

txt = "\n".join(out)
open("/Users/max/workplace/rs-bench2/analysis/ngram/fable-vs-opus.data.txt", "w").write(txt)
print(txt)
