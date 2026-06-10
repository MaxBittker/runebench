import { html, useEffect, useRef, useMemo } from '../html.js';
import { navigate } from '../router.js';

// High-effort ("xh") variants are folded into their base model: we never plot
// the xh point on its own — instead, if the xh run scored higher than the base
// run, the base model adopts the xh point (cost + score) but keeps the base
// label, so no "xh" text appears.
const XH_TO_BASE = {
  'fable-5-xhigh': 'fable-5',
  'opus48-max': 'opus48',
  'opus47-xhigh': 'opus47',
  'gpt55-apikey': 'gpt55',
  'gemini35flash-high': 'gemini35flash',
};

// Reuse the same per-model aggregation as CostTable: log-average performance
// (⟨ln⟩ of peak XP/min across the 16 skills) vs. average API cost per run.
function buildRows(data) {
  if (!data) return [];
  const out = [];
  for (const key of Object.keys(data)) {
    if (!MODEL_CONFIG[key]) continue;
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

export function CostScatter({ data }) {
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
        x: r.avgCost,
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

    // Place a text label next to each point. Each label has a ring of
    // candidate positions (right, left, above, below, diagonals at two
    // distances); coordinate-descent sweeps let every label re-pick the
    // candidate with the least overlap against everyone else's current spot.
    // Overlap cost is symmetric, so sweeps monotonically improve and settle.
    const labelPlugin = {
      id: 'pointLabels',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        const meta = chart.getDatasetMeta(0);
        ctx.save();
        ctx.font = '600 11px "Google Sans", sans-serif';
        ctx.textBaseline = 'middle';

        const LABEL_H = 13; // collision height of one label row
        const PAD = 2;      // breathing room between label boxes
        const ICON_R = 13;  // keep-out radius around each point icon

        const iconBoxes = meta.data.map((el) => ({
          left: el.x - ICON_R, right: el.x + ICON_R,
          top: el.y - ICON_R, bottom: el.y + ICON_R,
        }));

        const boxOf = (L) => ({
          left: L.left - PAD, right: L.left + L.w + PAD,
          top: L.y - LABEL_H / 2 - PAD, bottom: L.y + LABEL_H / 2 + PAD,
        });
        const hits = (a, b) =>
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const inBounds = (b) =>
          b.left >= chartArea.left && b.right <= chartArea.right &&
          b.top >= chartArea.top && b.bottom <= chartArea.bottom;

        const overlapArea = (a, b) => {
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return ox > 0 && oy > 0 ? ox * oy : 0;
        };

        const labels = [];
        meta.data.forEach((el, i) => {
          const p = points[i];
          if (!p) return;
          const w = ctx.measureText(p.label).width;
          const mk = (dx, dy, align) => {
            const ax = el.x + dx;
            const left = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
            return { left, y: el.y + dy, align, anchorX: ax, d: Math.hypot(dx, dy) };
          };
          const candidates = [
            // near ring: right, left, above, below, diagonals
            mk(14, 0, 'left'), mk(-14, 0, 'right'),
            mk(0, -20, 'center'), mk(0, 20, 'center'),
            mk(13, -13, 'left'), mk(13, 13, 'left'),
            mk(-13, -13, 'right'), mk(-13, 13, 'right'),
            // mid ring: lets a label sidestep one icon without jumping far
            mk(21, 0, 'left'), mk(-21, 0, 'right'),
            mk(0, -26, 'center'), mk(0, 26, 'center'),
            mk(18, -18, 'left'), mk(18, 18, 'left'),
            mk(-18, -18, 'right'), mk(-18, 18, 'right'),
            // far ring, only reached when everything closer is crowded out
            mk(28, 0, 'left'), mk(-28, 0, 'right'),
            mk(0, -33, 'center'), mk(0, 33, 'center'),
            mk(24, -24, 'left'), mk(24, 24, 'left'),
            mk(-24, -24, 'right'), mk(-24, 24, 'right'),
          ].filter((c) => inBounds(boxOf({ ...c, w })));
          if (candidates.length === 0) candidates.push(mk(14, 0, 'left'));
          labels.push({ p, w, idx: i, candidates, ...candidates[0] });
        });

        // Cost of placing label k at candidate c: overlap with every other
        // label's current spot, plus (weighted) overlap with other icons, plus
        // a distance penalty that keeps labels anchored near their own dot —
        // drifting to the far ring has to earn its keep in overlap savings.
        const costAt = (k, c, ci) => {
          const box = boxOf({ ...c, w: labels[k].w });
          let cost = c.d * 2.5 + ci * 0.25;
          for (let m = 0; m < labels.length; m++) {
            if (m !== k) cost += overlapArea(box, boxOf(labels[m]));
          }
          for (let j = 0; j < iconBoxes.length; j++) {
            if (j !== labels[k].idx) cost += overlapArea(box, iconBoxes[j]) * 2;
          }
          return cost;
        };

        for (let sweep = 0; sweep < 4; sweep++) {
          let improved = false;
          for (let k = 0; k < labels.length; k++) {
            const L = labels[k];
            let best = null;
            let bestCost = Infinity;
            L.candidates.forEach((c, ci) => {
              const cost = costAt(k, c, ci);
              if (cost < bestCost) { bestCost = cost; best = c; }
            });
            if (best && (best.left !== L.left || best.y !== L.y)) {
              Object.assign(L, best);
              improved = true;
            }
          }
          if (!improved) break;
        }

        // White halo behind the text keeps labels readable when a dense
        // cluster forces one to graze an icon.
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineJoin = 'round';
        for (const L of labels) {
          ctx.textAlign = L.align;
          ctx.strokeText(L.p.label, L.anchorX, L.y);
          ctx.fillStyle = L.p.color;
          ctx.fillText(L.p.label, L.anchorX, L.y);
        }
        ctx.restore();
      },
    };

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

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [rows]);

  if (!data || rows.length === 0) return null;

  return html`
    <div style=${{ position: 'relative', height: '480px' }}>
      <canvas ref=${canvasRef}></canvas>
    </div>
  `;
}
