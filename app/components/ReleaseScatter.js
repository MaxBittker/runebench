import { html, useEffect, useRef, useMemo } from '../html.js';
import { navigate } from '../router.js';
import { makeLabelPlugin } from './scatter-labels.js';

// High-effort ("xh") variants are folded into their base model: we never plot
// the xh point on its own — instead, if the xh run scored higher than the base
// run, the base model adopts the xh point (score) but keeps the base label, so
// no "xh" text appears. (Release date is shared between base and xh.)
const XH_TO_BASE = {
  'opus5-xhigh': 'opus5',
  'fable-5-xhigh': 'fable-5',
  'opus48-max': 'opus48',
  'opus47-xhigh': 'opus47',
  'gpt55-apikey': 'gpt55',
  'gemini35flash-high': 'gemini35flash',
};

// Per-model aggregation: log-average performance (⟨ln⟩ of peak XP/min across
// the 16 skills) vs. the model's release date (x-axis).
function buildRows(data) {
  if (!data) return [];
  const out = [];
  for (const key of Object.keys(data)) {
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function ReleaseScatter({ data }) {
  const canvasRef = useRef(null);
  const chartInstance = useRef(null);

  const rows = useMemo(() => buildRows(data), [data]);

  useEffect(() => {
    if (!canvasRef.current || rows.length === 0) return;
    if (!window.Chart) return;

    // Preload model icons so points can be drawn as logos.
    const points = rows.map((r) => {
      const cfg = MODEL_CONFIG[r.key];
      const img = new Image(20, 20);
      img.src = cfg.icon;
      return {
        x: r.releaseMs,
        y: r.logMean,
        key: r.key,
        label: cfg.shortName,
        color: cfg.color,
        img,
      };
    });

    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }

    const labelPlugin = makeLabelPlugin(points, 'pointLabelsRelease');

    chartInstance.current = new Chart(canvasRef.current, {
      type: 'scatter',
      data: {
        datasets: [{
          data: points,
          pointStyle: points.map((p) => p.img),
          pointRadius: 11,
          pointHoverRadius: 13,
          backgroundColor: points.map((p) => p.color),
          borderColor: points.map((p) => p.color),
        }],
      },
      plugins: [labelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        onClick: (evt, els) => {
          if (!els.length) return;
          const p = points[els[0].index];
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
            title: { display: true, text: '⟨ln⟩ XP/min' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = points[item.dataIndex];
                return `${p.label}: ${fmtDate(p.x)} / ⟨ln⟩ ${p.y.toFixed(1)}`;
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
  }, [rows]);

  if (!data || rows.length === 0) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="has-text-centered" style=${{ marginBottom: '2rem' }}>
          <h2 className="title is-3">Performance vs. Release Date</h2>
          <p className="subtitle is-6" style=${{ color: '#666' }}>
            Log-averaged peak XP rate across 16 skills vs. each model's release date
            (dates from <a href="https://models.dev/" target="_blank" rel="noopener">models.dev</a>)
          </p>
        </div>
        <div style=${{ position: 'relative', height: '520px' }}>
          <canvas ref=${canvasRef}></canvas>
        </div>
      </div>
    </section>
  `;
}
