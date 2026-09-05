import { html, useEffect, useRef, useMemo, useState } from '../html.js';
import { navigate } from '../router.js';
import { makeLabelPlugin } from './scatter-labels.js';

// High-effort ("xh") variants are folded into their base model: we never plot
// the xh point on its own — instead, if the xh run scored higher than the base
// run, the base model adopts the xh point (score) but keeps the base label, so
// no "xh" text appears. (Release date is shared between base and xh.)
const XH_TO_BASE = {
  'opus5-xhigh': 'opus5',
  'gpt6astra-high': 'gpt6astra',
  'fable51-xhigh': 'fable51',
  'fable-5-xhigh': 'fable-5',
  'opus48-max': 'opus48',
  'opus47-xhigh': 'opus47',
  'gpt55-apikey': 'gpt55',
  'gemini35flash-high': 'gemini35flash',
};

// Models left off this chart. The earliest model plotted is always on the
// frontier by construction, so weak early releases (gpt-oss-120b, Qwen3 Max)
// would anchor the line at a point nobody is comparing against.
const EXCLUDED = new Set(['gptoss120b', 'qwen3max']);

// Per-model aggregation: log-average performance (⟨ln⟩ of peak XP/min across
// the 16 skills) vs. the model's release date (x-axis).
function buildRows(data) {
  if (!data) return [];
  const out = [];
  for (const key of Object.keys(data)) {
    if (EXCLUDED.has(key)) continue;
    const cfg = MODEL_CONFIG[key];
    if (!cfg || !cfg.releaseDate) continue;
    const releaseMs = Date.parse(cfg.releaseDate);
    if (Number.isNaN(releaseMs)) continue;

    let logSum = 0;
    let rateCount = 0;

    for (const skill of SKILL_ORDER) {
      const sd = data[key]?.[skill];
      if (!sd) continue;
      const rate = sd.peakXpRate || 0;
      logSum += Math.log(1 + rate);
      rateCount++;
    }

    if (rateCount === 0) continue;

    out.push({
      key,
      logMean: logSum / rateCount,
      releaseMs,
    });
  }

  // Fold xh variants into their base model, keeping the higher-scoring point.
  const byKey = new Map(out.map((r) => [r.key, r]));
  for (const [xhKey, baseKey] of Object.entries(XH_TO_BASE)) {
    const xh = byKey.get(xhKey);
    if (!xh) continue;
    byKey.delete(xhKey); // never plot the xh point on its own
    const base = byKey.get(baseKey);
    if (!base) {
      byKey.set(baseKey, { ...xh, key: baseKey });
    } else if (xh.logMean > base.logMean) {
      base.logMean = xh.logMean;
    }
  }
  return [...byKey.values()];
}

// Models on the date/score frontier: each one raised the best score seen as
// of its release date. Ties on date resolve to the higher scorer, so only one
// model per release day can join.
function frontierKeys(rows) {
  const sorted = [...rows].sort((a, b) => a.releaseMs - b.releaseMs || b.logMean - a.logMean);
  const keys = new Set();
  let best = -Infinity;
  for (const r of sorted) {
    if (r.logMean > best) {
      best = r.logMean;
      keys.add(r.key);
    }
  }
  return keys;
}

// Ink shared by the frontier step line and the rings on frontier points, so
// the two read as one annotation layer sitting behind the model logos.
const FRONTIER_INK = 'rgba(70, 70, 78, 0.55)';
const ICON_R = 13; // matches the label plugin's icon keep-out radius

// One Image per icon src for the page's life: the toggles rebuild the chart,
// and a fresh Image per rebuild starts !complete even when the file is in the
// HTTP cache — Chart.js then draws nothing for that point and never revisits
// it. Icons that are still loading repaint the chart once they land.
const iconCache = new Map();
function iconFor(src, repaint) {
  let img = iconCache.get(src);
  if (!img) {
    img = new Image(20, 20);
    img.src = src;
    iconCache.set(src, img);
  }
  if (!(img.complete && img.naturalWidth)) {
    img.addEventListener('load', repaint, { once: true });
  }
  return img;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function ReleaseScatter({ data }) {
  const canvasRef = useRef(null);
  const chartInstance = useRef(null);

  // Non-frontier models are hidden by default; the frontier itself is always
  // computed over every model, so showing the rest never moves the line.
  const [showAll, setShowAll] = useState(false);
  // y axis: log (⟨ln⟩ XP/min, the site's usual score) or linear (the
  // geometric-mean XP/min that ⟨ln⟩ is the log of).
  const [linear, setLinear] = useState(false);

  const allRows = useMemo(() => buildRows(data), [data]);
  const frontier = useMemo(() => frontierKeys(allRows), [allRows]);
  const rows = useMemo(
    () => (showAll ? allRows : allRows.filter((r) => frontier.has(r.key))),
    [allRows, frontier, showAll]
  );
  const yOf = (logMean) => (linear ? Math.exp(logMean) - 1 : logMean);

  useEffect(() => {
    if (!canvasRef.current || rows.length === 0) return;
    if (!window.Chart) return;

    const repaint = () => chartInstance.current && chartInstance.current.update('none');

    // Model icons drawn as the points, shared across rebuilds.
    const points = rows.map((r) => {
      const cfg = MODEL_CONFIG[r.key];
      const img = iconFor(cfg.icon, repaint);
      return {
        x: r.releaseMs,
        y: yOf(r.logMean),
        logMean: r.logMean,
        key: r.key,
        label: cfg.shortName,
        color: cfg.color,
        img,
        frontier: frontier.has(r.key),
        big: frontier.has(r.key),
      };
    });

    // Best-score-to-date staircase: holds each frontier model's score until
    // the next one beats it, then steps up. The final tread runs out to today
    // so the current record reads as still standing.
    const steps = rows
      .filter((r) => frontier.has(r.key))
      .sort((a, b) => a.releaseMs - b.releaseMs)
      .map((r) => ({ x: r.releaseMs, y: yOf(r.logMean) }));
    if (steps.length) {
      const last = steps[steps.length - 1];
      steps.push({ x: Math.max(Date.now(), last.x), y: last.y });
    }

    // Rings behind frontier points, drawn before the datasets so the logo sits
    // on top and the ring ties the point to the step line it belongs to.
    const ringPlugin = {
      id: 'frontierRings',
      beforeDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const { ctx } = chart;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = FRONTIER_INK;
        meta.data.forEach((el, i) => {
          if (!points[i] || !points[i].frontier) return;
          ctx.beginPath();
          ctx.arc(el.x, el.y, ICON_R + 3, 0, Math.PI * 2);
          ctx.stroke();
        });
        ctx.restore();
      },
    };

    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }

    const labelPlugin = makeLabelPlugin(points, 'pointLabelsRelease');

    chartInstance.current = new Chart(canvasRef.current, {
      type: 'scatter',
      data: {
        datasets: [
          {
            data: points,
            pointStyle: points.map((p) => p.img),
            pointRadius: 11,
            pointHoverRadius: 13,
            backgroundColor: points.map((p) => p.color),
            borderColor: points.map((p) => p.color),
          },
          // Dataset 1 draws beneath dataset 0 (Chart.js paints last-to-first),
          // so the step line runs under the logos. No points, no hit-testing:
          // it is an annotation, not something to hover or click.
          {
            type: 'line',
            data: steps,
            // Chart.js's naming is inverted from the usual step-plot sense:
            // 'before' draws the tread first (hold the old record) and the
            // riser at the new model's release date — over, then up.
            stepped: 'before',
            borderColor: FRONTIER_INK,
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHitRadius: 0,
            pointHoverRadius: 0,
            fill: false,
          },
        ],
      },
      plugins: [ringPlugin, labelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        // See CostScatter: animating point positions re-solves the label
        // layout on every frame.
        animation: false,
        onClick: (evt, els) => {
          const hit = els.find((e) => e.datasetIndex === 0);
          if (!hit) return;
          const p = points[hit.index];
          if (p) navigate('trajectory/' + p.key + '/' + SKILL_ORDER[0]);
        },
        onHover: (evt, els) => {
          evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Model Release Date' },
            ticks: {
              maxRotation: 0,
              autoSkipPadding: 24,
              callback: (v) => fmtDate(v),
            },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: linear ? 'XP/min (geometric mean)' : '⟨ln⟩ XP/min' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex === 0,
            callbacks: {
              label: (item) => {
                const p = points[item.dataIndex];
                const tag = p.frontier ? ' — best at release' : '';
                const gm = Math.round(Math.exp(p.logMean) - 1);
                return `${p.label}: ${fmtDate(p.x)} / ⟨ln⟩ ${p.logMean.toFixed(1)} (${gm} XP/min)${tag}`;
              },
            },
          },
        },
      },
    });

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [rows, frontier, linear]);

  if (!data || allRows.length === 0) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="has-text-centered" style=${{ marginBottom: '2rem', position: 'relative' }}>
          <h2 className="title is-3">Performance vs. Release Date</h2>
          <div
            style=${{
              position: 'absolute',
              right: 0,
              top: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              fontSize: '0.8rem',
              color: '#666',
            }}
          >
            <label className="checkbox" style=${{ fontSize: 'inherit', color: 'inherit' }}>
              <input
                type="checkbox"
                checked=${showAll}
                onChange=${(e) => setShowAll(e.target.checked)}
                style=${{ marginRight: '0.35em' }}
              />
              Show all models
            </label>
            <div className="buttons has-addons are-small" style=${{ marginBottom: 0 }}>
              ${['log', 'linear'].map((mode) => html`
                <button
                  key=${mode}
                  type="button"
                  className=${'button is-small' + ((mode === 'linear') === linear ? ' is-dark is-selected' : '')}
                  style=${{ marginBottom: 0 }}
                  onClick=${() => setLinear(mode === 'linear')}
                >
                  ${mode}
                </button>
              `)}
            </div>
          </div>
          <p className="subtitle is-6" style=${{ color: '#666' }}>
            Log-averaged peak XP rate across 16 skills vs. each model's release date
            (dates from <a href="https://models.dev/" target="_blank" rel="noopener">models.dev</a>).
            The dashed line tracks the best score to date; ringed models are the ones that set it.
          </p>
        </div>
        <div style=${{ position: 'relative', height: '520px' }}>
          <canvas ref=${canvasRef}></canvas>
        </div>
      </div>
    </section>
  `;
}
