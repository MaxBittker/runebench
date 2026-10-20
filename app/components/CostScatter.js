import { html, useEffect, useRef, useMemo, useState } from '../html.js';
import { makeLabelPlugin } from './scatter-labels.js';

// Thinking-effort variants (opus5-xhigh, gpt61sol-low, grok46-medium, …) share
// a family with their default-effort row, and only the variants that earn a
// spot are plotted. A variant is hidden when its score is within
// VARIANT_SCORE_TOL of the default's (in doubt, show the default) or when
// another row of its family Pareto-dominates it (cheaper-or-equal and
// higher-or-equal scoring). The default itself is hidden only when a surviving
// variant dominates it.
const THINKING_SUFFIX = /-(xhigh|high|medium|low|max)$/;
const VARIANT_SCORE_TOL = 0.1; // ⟨ln⟩ units, ~10% XP/min

function familyOf(key) {
  return key.replace(THINKING_SUFFIX, '');
}

function dominates(o, r) {
  return o.avgCost <= r.avgCost && o.logMean >= r.logMean &&
    (o.avgCost < r.avgCost || o.logMean > r.logMean);
}

function dropDominatedVariants(rows) {
  const families = new Map();
  for (const r of rows) {
    const f = familyOf(r.key);
    if (!families.has(f)) families.set(f, []);
    families.get(f).push(r);
  }
  const out = [];
  for (const [f, members] of families) {
    const def = members.find((r) => r.key === f);
    const variants = members.filter((r) => r !== def);
    const kept = variants.filter((v) =>
      !(def && Math.abs(v.logMean - def.logMean) < VARIANT_SCORE_TOL) &&
      !members.some((o) => o !== v && dominates(o, v))
    );
    if (def && !kept.some((v) => dominates(v, def))) out.push(def);
    out.push(...kept);
  }
  return out;
}

// Models intentionally hidden from the cost scatter (older points that clutter
// the frontier without adding signal).
const EXCLUDED = new Set(['sonnet45', 'gemini', 'kimi26', 'muse', 'codex53', 'qwen3max', 'qwen37max', 'gpt55', 'gpt55-apikey', 'gptoss120b']);

// By default only models released within this many days of the newest
// release on the board are plotted; the "show older" toggle brings the rest
// back. Anchored to the newest release (not today) so the view doesn't drift
// empty between runs. Models with no releaseDate are always shown.
const RECENT_WINDOW_DAYS = 90;

// Older models kept on the default view regardless of the recency window —
// reference points for how far cheap new models have come (Opus 4.5/4.6 vs
// Haiku 5.5).
const ALWAYS_SHOWN = new Set(['opus', 'opus45']);

// Reuse the same per-model aggregation as CostTable: log-average performance
// (⟨ln⟩ of peak XP/min across the 16 skills) vs. average API cost per run.
function buildRows(data) {
  if (!data) return [];
  const out = [];
  for (const key of Object.keys(data)) {
    if (!MODEL_CONFIG[key]) continue;
    if (EXCLUDED.has(key)) continue;
    let logSum = 0;
    let rateCount = 0;
    let totalCost = 0;
    let runsWithCost = 0;

    for (const skill of SKILL_ORDER) {
      const sd = data[key]?.[skill];
      if (!sd) continue;
      const rate = sd.peakXpRate || 0;
      logSum += Math.log(1 + rate);
      rateCount++;

      const tu = sd.tokenUsage;
      if (tu && tu.costUsd != null) {
        totalCost += tu.costUsd;
        runsWithCost++;
      }
    }

    // Zero-score skills count (ln(1+0) = 0 in the mean), but a model missing
    // skill runs entirely (e.g. gpt4o, woodcutting only) would be averaged over
    // a subset — leave it off rather than plot an inflated score.
    // ($0 can't sit on the log cost axis.)
    if (rateCount < SKILL_ORDER.length || runsWithCost === 0 || totalCost <= 0) continue;

    const releaseMs = Date.parse(MODEL_CONFIG[key].releaseDate);
    out.push({
      key,
      releaseMs: Number.isNaN(releaseMs) ? null : releaseMs,
      logMean: logSum / rateCount,
      avgCost: totalCost / runsWithCost,
    });
  }

  return out;
}

// Keys of models on the Pareto frontier: no other model is both cheaper (or
// equal) and higher-scoring (or equal), with at least one strict improvement.
function paretoKeys(rows) {
  const keys = new Set();
  for (const r of rows) {
    const dominated = rows.some(
      (o) =>
        o !== r &&
        o.avgCost <= r.avgCost &&
        o.logMean >= r.logMean &&
        (o.avgCost < r.avgCost || o.logMean > r.logMean)
    );
    if (!dominated) keys.add(r.key);
  }
  return keys;
}

// Icons are shared across chart rebuilds (hiding a model or toggling older
// ones tears the chart down and back up): a fresh Image per rebuild starts
// !complete even when the file is in the HTTP cache. One Image per src, kept
// for the page's life.
const iconCache = new Map();

function iconFor(src) {
  let img = iconCache.get(src);
  if (!img) {
    img = new Image(20, 20);
    img.src = src;
    iconCache.set(src, img);
  }
  return img;
}

// 1-2-5 sequence helpers for the log cost axis.
const STEP_MULTS = [1, 2, 5];

function niceSteps(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of STEP_MULTS) {
      const v = +(m * 10 ** e).toPrecision(3);
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

// Nearest 1-2-5 step strictly past v (a v already on a step still gets
// padded, so its icon clears the axis edge).
function niceStep(v, dir) {
  const steps = niceSteps(v / 10, v * 10);
  return dir === 'down'
    ? steps.filter((s) => s < v).pop()
    : steps.find((s) => s > v);
}

// Pareto frontier as a faint dashed line through the frontier points (cheapest
// first), drawn under the icons. A plugin rather than a line dataset so it never
// shows up in tooltips or click hit-testing.
function makeFrontierPlugin(frontierPts) {
  return {
    id: 'paretoFrontier',
    beforeDatasetsDraw(chart) {
      if (frontierPts.length < 2) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(120, 120, 120, 0.55)';
      ctx.beginPath();
      frontierPts.forEach((p, i) => {
        const x = scales.x.getPixelForValue(p.x);
        const y = scales.y.getPixelForValue(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    },
  };
}

export function CostScatter({ data }) {
  const canvasRef = useRef(null);
  const chartInstance = useRef(null);
  const [showOlder, setShowOlder] = useState(false);
  // Session-local set of models hidden by clicking their point — not
  // persisted anywhere, a reload brings everything back.
  const [hidden, setHidden] = useState(() => new Set());

  const allRows = useMemo(() => buildRows(data), [data]);
  const cutoffMs = useMemo(() => {
    const dates = allRows.map((r) => r.releaseMs).filter((ms) => ms != null);
    return dates.length ? Math.max(...dates) - RECENT_WINDOW_DAYS * 86400000 : -Infinity;
  }, [allRows]);
  const isRecent = (r) => r.releaseMs == null || r.releaseMs >= cutoffMs || ALWAYS_SHOWN.has(r.key);
  const olderCount = useMemo(
    () => allRows.filter((r) => !isRecent(r)).length,
    [allRows, cutoffMs]
  );
  const rows = useMemo(
    () => dropDominatedVariants(
      allRows.filter((r) => !hidden.has(r.key) && (showOlder || isRecent(r)))
    ),
    [allRows, hidden, showOlder, cutoffMs]
  );
  const frontier = useMemo(() => paretoKeys(rows), [rows]);

  useEffect(() => {
    if (!canvasRef.current || !window.Chart) return;
    if (rows.length === 0) {
      // Everything hidden — tear down the stale chart; the restore link stays.
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
      return;
    }

    // Preload model icons so points can be drawn as logos.
    const points = rows.map((r) => {
      const cfg = MODEL_CONFIG[r.key];
      return {
        x: r.avgCost,
        y: r.logMean,
        key: r.key,
        label: cfg.shortName,
        color: cfg.color,
        img: iconFor(cfg.icon),
      };
    });
    // Log cost axis: pad out to the 1-2-5 steps just past the cheapest and
    // priciest points so edge icons aren't sitting on the axis.
    const costs = points.map((p) => p.x);
    const xMin = niceStep(Math.min(...costs), 'down');
    const xMax = niceStep(Math.max(...costs), 'up');
    const frontierPts = points
      .filter((p) => frontier.has(p.key))
      .sort((a, b) => a.x - b.x);

    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }

    const labelPlugin = makeLabelPlugin(points, 'pointLabelsCost');

    chartInstance.current = new Chart(canvasRef.current, {
      type: 'scatter',
      data: {
        datasets: [{
          data: points,
          // Let edge icons overflow the chart area a little.
          clip: 14,
          pointStyle: points.map((p) => p.img),
          pointRadius: 11,
          pointHoverRadius: 13,
          backgroundColor: points.map((p) => p.color),
          borderColor: points.map((p) => p.color),
        }],
      },
      plugins: [makeFrontierPlugin(frontierPts), labelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        // Point positions move on every animation frame, which invalidates the
        // label plugin's layout cache and re-solves placements ~60 times for
        // one rebuild. The entry animation isn't worth that.
        animation: false,
        scales: {
          x: {
            type: 'logarithmic',
            min: xMin,
            max: xMax,
            title: { display: true, text: 'Avg API Cost / Run (USD, log scale)' },
            // Chart.js's default log ticks are every integer multiple of each
            // decade (1,2,3…9,10,20…); keep just the 1-2-5 steps.
            afterBuildTicks: (axis) => {
              axis.ticks = niceSteps(xMin, xMax).map((value) => ({ value }));
            },
            ticks: {
              callback: (v) => '$' + v,
            },
          },
          y: {
            title: { display: true, text: '⟨ln⟩ XP/min' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = points[item.dataIndex];
                return `${p.label}: $${p.x.toFixed(2)} / ⟨ln⟩ ${p.y.toFixed(1)}`;
              },
            },
          },
        },
      },
    });

    const canvas = canvasRef.current;
    // Point index under the cursor — the dot itself or its placed label.
    const idxAt = (e) => {
      const chart = chartInstance.current;
      if (!chart) return -1;
      const els = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
      if (els.length) return els[0].index;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (const L of labelPlugin.getLabels() || []) {
        if (x >= L.left - 2 && x <= L.left + L.w + 2 && Math.abs(y - L.y) <= L.h / 2 + 2) {
          return L.idx;
        }
      }
      return -1;
    };
    const onMove = (e) => {
      const idx = idxAt(e);
      canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
    };
    // Clicking a model (dot or label) hides it for this session; the chart
    // rebuilds and the axes re-fit to the models that remain.
    const onClick = (e) => {
      const idx = idxAt(e);
      const p = idx >= 0 ? points[idx] : null;
      if (!p) return;
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(p.key);
        return next;
      });
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [rows, frontier]);

  if (!data || allRows.length === 0) return null;

  return html`
    <div>
      <div style=${{ position: 'relative', marginBottom: '0.5rem' }}>
        <h2 className="title is-3 has-text-centered" style=${{ marginBottom: 0 }}>
          Cost vs. Performance
        </h2>
        ${hidden.size > 0 && html`
          <a
            onClick=${() => setHidden(new Set())}
            style=${{
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '0.8rem',
              color: '#666',
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            restore ${hidden.size} hidden
          </a>
        `}
        <div
          style=${{
            position: 'absolute',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            gap: '0.9em',
            fontSize: '0.8rem',
            color: '#666',
          }}
        >
        ${olderCount > 0 && html`
          <label className="checkbox">
            <input
              type="checkbox"
              checked=${showOlder}
              onChange=${(e) => setShowOlder(e.target.checked)}
              style=${{ marginRight: '0.35em' }}
            />
            Show older (${olderCount})
          </label>
        `}
        </div>
      </div>
      <div style=${{ position: 'relative', height: '480px' }}>
        <canvas ref=${canvasRef}></canvas>
      </div>
    </div>
  `;
}
