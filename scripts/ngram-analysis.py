#!/usr/bin/env python3
"""N-gram analysis of model narration text across harnesses.

Models / harnesses:
  fable  -> claude-code.txt  (Claude harness)
  opus   -> claude-code.txt  (Claude harness, opus 4.8)
  gpt55  -> codex.txt        (Codex harness)
  gemini -> gemini-cli.txt   (Gemini CLI harness, 3.5 flash)

Caveat: gpt55/gemini are cross-harness vs fable/opus, so differences are
model+harness confounded. fable-vs-opus is the clean same-harness comparison.
"""
import json, re, glob, os, sys, math
from collections import Counter, defaultdict

JOBS = "/Users/max/workplace/rs-bench2/jobs"

MODELS = {
    "fable":  ("claude", f"{JOBS}/skills-30m-fable-2026*/*/agent/claude-code.txt"),
    "opus":   ("claude", f"{JOBS}/skills-30m-opus48-2026*/*/agent/claude-code.txt"),
    "gpt55":  ("codex",  f"{JOBS}/skills-30m-gpt55-apikey*/*/agent/codex.txt"),
    "gemini": ("gemini", f"{JOBS}/skills-30m-gemini35flash-2026*/*/agent/gemini-cli.txt"),
}

ANSI = re.compile(r"\x1b\[[0-9;]*m")

def skill_of(path):
    # .../firemaking-xp-30m__zqKxy6j/agent/...
    for part in path.split("/"):
        if "-xp-" in part and "__" in part:
            return part.split("-xp-")[0]
    return "?"

def extract_claude(path):
    out = []
    for line in open(path, errors="ignore"):
        line = line.strip()
        if not line.startswith("{"): continue
        try: o = json.loads(line)
        except: continue
        if o.get("type") != "assistant": continue
        msg = o.get("message", {})
        if msg.get("model") == "<synthetic>":  # harness-injected, not model-generated
            continue
        for b in msg.get("content", []):
            if b.get("type") == "text":
                out.append(b.get("text", ""))
    return "\n".join(out)

def extract_codex(path):
    out = []
    for line in open(path, errors="ignore"):
        line = line.strip()
        if not line.startswith("{"): continue
        try: o = json.loads(line)
        except: continue
        if o.get("type") == "item.completed":
            it = o.get("item", {})
            if it.get("type") == "agent_message":
                out.append(it.get("text", ""))
    return "\n".join(out)

GEMINI_NOISE = re.compile(
    r"(YOLO mode|Approval mode|trusted dir|Ripgrep is not|Error executing tool|"
    r"Path not in workspace|Falling back to|^missing |GEMINI_CLI_TRUST|not running in a trusted|"
    r"Loaded cached|Flushing|Data collection|^\s*$)", re.I)

def extract_gemini(path):
    out = []
    for line in open(path, errors="ignore"):
        line = ANSI.sub("", line).rstrip("\n")
        if not line.strip(): continue
        if GEMINI_NOISE.search(line): continue
        out.append(line)
    return "\n".join(out)

EXTRACT = {"claude": extract_claude, "codex": extract_codex, "gemini": extract_gemini}

# ---- build corpora: one (best) trajectory per skill per model -------------
corpora = {}   # model -> concatenated text
per_skill_files = {}
for model, (fmt, pat) in MODELS.items():
    best = {}  # skill -> (len, text)
    files = glob.glob(pat)
    for f in files:
        txt = EXTRACT[fmt](f)
        sk = skill_of(f)
        if sk not in best or len(txt) > best[sk][0]:
            best[sk] = (len(txt), txt)
    raw = "\n".join(t for _, t in best.values())
    corpora[model] = raw.replace("’", "'").replace("‘", "'").replace("‘", "'")
    per_skill_files[model] = sorted(best.keys())
    print(f"{model:8s}: {len(files):3d} files -> {len(best):2d} skills, "
          f"{len(corpora[model]):>8d} chars", file=sys.stderr)

# ---- tokenize -------------------------------------------------------------
WORD = re.compile(r"[a-z][a-z']*[a-z]|[a-z]")
def tokenize(text):
    return WORD.findall(text.lower())

tokens = {m: tokenize(t) for m, t in corpora.items()}

def ngrams(toks, n):
    return [" ".join(toks[i:i+n]) for i in range(len(toks)-n+1)]

def counts(model, n):
    return Counter(ngrams(tokens[model], n))

STOP = set("the a an and or of to in on at for with is are was be it this that as i we you "
           "will to do so but if then now our my me your".split())

def per_million(counter, total):
    return {g: c*1_000_000/total for g, c in counter.items()}

# ---- distinctiveness: model vs pooled others ------------------------------
def distinctive(target, n, min_count=5, content_only=False, topk=30):
    tc = counts(target, n)
    tot_t = sum(tc.values())
    others = Counter()
    tot_o = 0
    for m in MODELS:
        if m == target: continue
        c = counts(m, n)
        others += c
        tot_o += sum(c.values())
    rows = []
    for g, c in tc.items():
        if c < min_count: continue
        if content_only and n == 1 and g in STOP: continue
        f_t = c / tot_t
        f_o = (others.get(g, 0)) / tot_o
        # log-ratio with add-smoothing in per-million space
        lr = math.log((f_t*1e6 + 1) / (f_o*1e6 + 1))
        rows.append((lr, g, c, f_t*1e6, f_o*1e6))
    rows.sort(reverse=True)
    return rows[:topk]

def pairwise(a, b, n, min_count=4, content_only=False, topk=30):
    ca, cb = counts(a, n), counts(b, n)
    ta, tb = sum(ca.values()), sum(cb.values())
    rows = []
    keys = set(ca) | set(cb)
    for g in keys:
        na, nb = ca.get(g, 0), cb.get(g, 0)
        if max(na, nb) < min_count: continue
        if content_only and n == 1 and g in STOP: continue
        fa, fb = na/ta*1e6, nb/tb*1e6
        lr = math.log((fa+1)/(fb+1))
        rows.append((lr, g, na, nb, fa, fb))
    rows.sort(reverse=True)
    return rows

OUT = "/Users/max/workplace/rs-bench2/analysis/ngram"
os.makedirs(OUT, exist_ok=True)

def fmt_rows(rows, head):
    lines = [head]
    for lr, g, c, ft, fo in rows:
        lines.append(f"  {lr:+5.2f}  {g:<32s} n={c:<4d} self={ft:7.1f}/M  others={fo:7.1f}/M")
    return "\n".join(lines)

# ---- curated discourse / phrasing markers (style, not task content) --------
MARKERS = {
    "let me":            r"\blet me\b",
    "let's":             r"\blet'?s\b",
    "i'll":              r"\bi'?ll\b",
    "i will":            r"\bi will\b",
    "i'm going to":      r"\bi'?m going to\b",
    "i need to":         r"\bi need to\b",
    "i'm":               r"\bi'?m\b",
    "now":               r"\bnow\b",
    "first":             r"\bfirst\b",
    "next":              r"\bnext\b",
    "then":              r"\bthen\b",
    "actually":          r"\bactually\b",
    "wait":              r"\bwait\b",
    "perfect":           r"\bperfect\b",
    "great":             r"\bgreat\b",
    "excellent":         r"\bexcellent\b",
    "okay/ok":           r"\bok(ay)?\b",
    "hmm":               r"\bhm+\b",
    "let me think":      r"\blet me think\b",
    "the issue":         r"\bthe (issue|problem)\b",
    "let me check":      r"\blet me check\b",
    "i see":             r"\bi see\b",
    "looks like":        r"\blooks? like\b",
    "should":            r"\bshould\b",
    "strategy":          r"\bstrateg(y|ies|ic)\b",
    "baseline":          r"\bbaseline\b",
    "peak (xp)":         r"\bpeak\b",
    "maximize/optimal":  r"\b(maxim(ize|um|al)|optimal|optimize)\b",
    "verify/confirm":    r"\b(verify|confirm|check)\b",
    "! (exclaim)":       r"!",
    "minutes left":      r"\bminutes? (left|remaining)\b",
    "we (1st pl)":       r"\bwe\b",
    "i (1st sg)":        r"\bi\b",
    # --- numeric / mathematical register (fable's signature) ---
    "any digit":         r"\d",
    "k shorthand 12k":   r"\b\d+\.?\d*\s*k\b",
    "x multiplier 25x":  r"\b\d+\s*x\b|\bx\d+\b",
    "from-to / delta":   r"->|→|\bfrom .{0,14}\bto\b|\d+\s*[-–]\s*>\s*\d+",
    "level N":           r"\blevel \d|\blvl \d",
    "per/each/every":    r"\bper\b|\beach\b|\bevery\b",
    "xp rate /min /s":   r"xp\s*/?\s*(min|sec|s\b)|/\s*(min|s)\b|per (min|second)",
    "abstract math verb":r"\b(rate|ratio|calcul|multipl|divid|average|avg|optimiz|project|extrapolat)",
    "comparative":       r"\b(more|fewer|less|higher|lower|faster|slower|better)\b",
}
def marker_table():
    lines = ["per-1000-tokens rate of discourse/phrasing markers (style signal):",
             f"  {'marker':<20s}" + "".join(f"{m:>9s}" for m in MODELS)]
    for name, pat in MARKERS.items():
        rx = re.compile(pat, re.I)
        row = f"  {name:<20s}"
        for m in MODELS:
            hits = len(rx.findall(corpora[m].lower()))
            rate = hits * 1000 / max(1, len(tokens[m]))
            row += f"{rate:9.2f}"
        lines.append(row)
    return "\n".join(lines)

report = []
report.append("# N-gram analysis — model narration (30m skill runs)\n")
report.append("Corpus = best trajectory per skill per model. Frequencies are per-million tokens.")
report.append("Harness: fable & opus = claude-code; gpt55 = codex; gemini = gemini-cli.")
report.append("fable↔opus is the only same-harness (clean) comparison.\n")
report.append("Corpus sizes (tokens):")
for m in MODELS:
    report.append(f"  {m:8s} {len(tokens[m]):>8d} tokens, {len(set(tokens[m])):>6d} unique")
report.append("")
report.append("\n" + "="*70 + "\n## Discourse / phrasing markers (curated — pure style)\n" + "="*70)
report.append(marker_table())

# distinctive per model
for n, label in [(1,"unigrams"), (2,"bigrams"), (3,"trigrams")]:
    report.append(f"\n{'='*70}\n## Distinctive {label} (model vs pooled other 3)\n{'='*70}")
    for m in MODELS:
        rows = distinctive(m, n, content_only=(n==1), topk=20)
        report.append("\n" + fmt_rows(rows, f"### {m} — top {label} (content words only for unigrams)"))

# fable focus: fable vs opus, fable vs each
report.append(f"\n\n{'#'*70}\n# FABLE FOCUS\n{'#'*70}")
for other in ["opus", "gpt55", "gemini"]:
    for n, label in [(1,"unigrams"), (2,"bigrams"), (3,"trigrams")]:
        rows = pairwise("fable", other, n, content_only=(n==1))
        top_fable = rows[:18]
        top_other = rows[-18:][::-1]
        report.append(f"\n## fable vs {other} — {label}")
        report.append(f"-- MORE in fable than {other} --")
        for lr,g,na,nb,fa,fb in top_fable:
            report.append(f"  {lr:+5.2f}  {g:<30s} fable={fa:7.1f}/M  {other}={fb:7.1f}/M  (n {na} vs {nb})")
        report.append(f"-- MORE in {other} than fable --")
        for lr,g,na,nb,fa,fb in top_other:
            report.append(f"  {lr:+5.2f}  {g:<30s} fable={fa:7.1f}/M  {other}={fb:7.1f}/M  (n {na} vs {nb})")

txt = "\n".join(report)
open(f"{OUT}/REPORT.txt","w").write(txt)
# also dump raw top-lists json
dump = {}
for m in MODELS:
    dump[m] = {
        "tokens": len(tokens[m]),
        "unique": len(set(tokens[m])),
        "top_unigrams": Counter(tokens[m]).most_common(40),
        "top_bigrams": counts(m,2).most_common(40),
        "top_trigrams": counts(m,3).most_common(40),
        "skills": per_skill_files[m],
    }
json.dump(dump, open(f"{OUT}/raw.json","w"), indent=1)
print("\nwrote", f"{OUT}/REPORT.txt", file=sys.stderr)
print(txt)
