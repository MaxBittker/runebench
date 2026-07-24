import { html, useEffect, useRef, useMemo, useState } from '../html.js';
import { navigate } from '../router.js';
import { makeLabelPlugin } from './scatter-labels.js';

// High-effort ("xh") variants are folded into their base model: we never plot
// the xh point on its own — instead, if the xh run scored higher than the base
// run, the base model adopts the xh point (cost + score) but keeps the base
// label, so no "xh" text appears.
const XH_TO_BASE = {
  'opus5-xhigh': 'opus5',
  'fable-5-xhigh': 'fable-5',
  'opus48-max': 'opus48',
  'opus47-xhigh': 'opus47',
  'gpt55-apikey': 'gpt55',
  'gemini35flash-high': 'gemini35flash',
};

// Models intentionally hidden from the cost scatter (older points that clutter
// the frontier without adding signal).
const EXCLUDED = new Set(['sonnet45', 'gemini', 'opus45', 'kimi26', 'muse', 'codex53', 'qwen3max', 'qwen37max', 'gpt55', 'gpt55-apikey', 'gptoss120b']);

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

    if (rateCount === 0 || runsWithCost === 0) continue;

    out.push({
      key,
      logMean: logSum / rateCount,
      avgCost: totalCost / runsWithCost,
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
      // No base run — adopt the xh point under the base identity.
      byKey.set(baseKey, { ...xh, key: baseKey });
    } else if (xh.logMean > base.logMean) {
      // xh scored higher — base adopts the xh point but keeps its own label.
      base.logMean = xh.logMean;
      base.avgCost = xh.avgCost;
    }
  }
  return [...byKey.values()];
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

// Greyed-out copy of a model icon for off-frontier points. Icons are usually
// cached by this point, but redraw on load (and repaint the chart) if not.
function makeFadedIcon(img, repaint) {
  const c = document.createElement('canvas');
  c.width = 20;
  c.height = 20;
  const draw = () => {
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 20, 20);
    ctx.filter = 'grayscale(1) opacity(0.15)';
    ctx.drawImage(img, 0, 0, 20, 20);
  };
  if (img.complete && img.naturalWidth) {
    draw();
  } else {
    img.addEventListener('load', () => {
      draw();
      repaint();
    });
  }
  return c;
}

export function CostScatter({ data }) {
  const canvasRef = useRef(null);
  const chartInstance = useRef(null);
  const [frontierOnly, setFrontierOnly] = useState(false);

  const rows = useMemo(() => buildRows(data), [data]);
  const frontier = useMemo(() => paretoKeys(rows), [rows]);

  useEffect(() => {
    if (!canvasRef.current || rows.length === 0) return;
    if (!window.Chart) return;

    const repaint = () => chartInstance.current && chartInstance.current.update();

    // Preload model icons so points can be drawn as logos. When the frontier
    // toggle is on, off-frontier points get a greyed icon + grey label.
    const points = rows.map((r) => {
      const cfg = MODEL_CONFIG[r.key];
      const img = new Image(20, 20);
      img.src = cfg.icon;
      const dimmed = frontierOnly && !frontier.has(r.key);
      const dimImg = dimmed ? makeFadedIcon(img, repaint) : null;
      return {
        x: r.avgCost,
        y: r.logMean,
        key: r.key,
        label: cfg.shortName,
        color: dimmed ? '#b6b6b6' : cfg.color,
        img: dimmed ? dimImg : img,
        big: frontierOnly && frontier.has(r.key),
        alpha: dimmed ? 0.3 : 1,
        ghost: dimmed,
        // Kept for hover: a greyed point temporarily regains its full look.
        fullImg: img,
        fullColor: cfg.color,
        dimImg,
      };
    });

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
            beginAtZero: true,
            reverse: true,
            title: { display: true, text: 'Avg API Cost / Run (USD)' },
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

    // Hovering a greyed-out point — or its label — restores the pair's full
    // color until the pointer moves away. Layout is untouched (same size), so
    // the cached label placements are reused and nothing shifts.
    const canvas = canvasRef.current;
    let hoverIdx = -1;
    const applyHover = (idx) => {
      if (idx === hoverIdx) return;
      const chart = chartInstance.current;
      if (!chart) return;
      const ds = chart.data.datasets[0];
      const set = (i, on) => {
        const p = points[i];
        if (!p || !p.ghost) return false;
        p.color = on ? p.fullColor : '#b6b6b6';
        p.alpha = on ? 1 : 0.3;
        ds.pointStyle[i] = on ? p.fullImg : p.dimImg;
        ds.backgroundColor[i] = p.color;
        ds.borderColor[i] = p.color;
        return true;
      };
      const changed = set(hoverIdx, false) | set(idx, true);
      hoverIdx = idx;
      if (changed) chart.update('none');
    };
    const onMove = (e) => {
      const chart = chartInstance.current;
      if (!chart) return;
      const els = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
      let idx = els.length ? els[0].index : -1;
      if (idx === -1) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const L of labelPlugin.getLabels() || []) {
          if (x >= L.left - 2 && x <= L.left + L.w + 2 && Math.abs(y - L.y) <= L.h / 2 + 2) {
            idx = L.idx;
            break;
          }
        }
      }
      applyHover(idx);
    };
    const onLeave = () => applyHover(-1);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [rows, frontier, frontierOnly]);

  if (!data || rows.length === 0) return null;

  return html`
    <div>
      <div style=${{ position: 'relative', marginBottom: '0.5rem' }}>
        <h2 className="title is-3 has-text-centered" style=${{ marginBottom: 0 }}>
          Cost vs. Performance
        </h2>
        <label
          className="checkbox"
          style=${{
            position: 'absolute',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '0.8rem',
            color: '#666',
          }}
        >
          <input
            type="checkbox"
            checked=${frontierOnly}
            onChange=${(e) => setFrontierOnly(e.target.checked)}
            style=${{ marginRight: '0.35em' }}
          />
          Pareto frontier
        </label>
      </div>
      <div style=${{ position: 'relative', height: '480px' }}>
        <canvas ref=${canvasRef}></canvas>
      </div>
    </div>
  `;
}
