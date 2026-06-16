// Shared point-label placement for the scatter charts (CostScatter,
// ReleaseScatter). Each label has a ring of candidate positions around its
// dot; coordinate-descent sweeps let every label re-pick the candidate with
// the least overlap against everyone else's current spot. When a label ends
// up pushed away from its dot, a thin leader line connects the two so dense
// clusters stay readable.
//
// `points` is the array of plotted points in dataset order, each with
// { label, color }. Returns a Chart.js plugin.
export function makeLabelPlugin(points, id = 'pointLabels') {
  return {
    id,
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
          // far ring
          mk(30, 0, 'left'), mk(-30, 0, 'right'),
          mk(0, -34, 'center'), mk(0, 34, 'center'),
          mk(26, -22, 'left'), mk(26, 22, 'left'),
          mk(-26, -22, 'right'), mk(-26, 22, 'right'),
          // outer ring: a leader line keeps these tethered to their dot
          mk(44, 0, 'left'), mk(-44, 0, 'right'),
          mk(0, -46, 'center'), mk(0, 46, 'center'),
          mk(40, -30, 'left'), mk(40, 30, 'left'),
          mk(-40, -30, 'right'), mk(-40, 30, 'right'),
          mk(38, -42, 'left'), mk(38, 42, 'left'),
          mk(-38, -42, 'right'), mk(-38, 42, 'right'),
        ].filter((c) => inBounds(boxOf({ ...c, w })));
        if (candidates.length === 0) candidates.push(mk(14, 0, 'left'));
        labels.push({ p, w, idx: i, dotX: el.x, dotY: el.y, candidates, ...candidates[0] });
      });

      // Cost of placing label k at candidate c: overlap with every other
      // label's current spot, plus (weighted) overlap with other icons, plus a
      // mild distance penalty so labels prefer staying near their own dot —
      // pushing to an outer ring has to earn its keep in overlap savings. The
      // penalty is gentle (and capped) because leader lines keep far labels
      // legible, so separating an overlap is usually worth the extra distance.
      const costAt = (k, c, ci) => {
        const box = boxOf({ ...c, w: labels[k].w });
        let cost = Math.min(c.d, 30) * 1.4 + ci * 0.2;
        for (let m = 0; m < labels.length; m++) {
          if (m !== k) cost += overlapArea(box, boxOf(labels[m])) * 1.5;
        }
        for (let j = 0; j < iconBoxes.length; j++) {
          if (j !== labels[k].idx) cost += overlapArea(box, iconBoxes[j]) * 3;
        }
        return cost;
      };

      for (let sweep = 0; sweep < 6; sweep++) {
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

      // Leader lines: draw from the icon edge to the nearest point of the
      // label box when the label sits clearly away from its dot. Drawn first
      // so the text + white halo render on top.
      ctx.lineWidth = 1;
      for (const L of labels) {
        const box = {
          left: L.left, right: L.left + L.w,
          top: L.y - LABEL_H / 2, bottom: L.y + LABEL_H / 2,
        };
        // Nearest point on the (unpadded) label box to the dot center.
        const nx = Math.max(box.left, Math.min(L.dotX, box.right));
        const ny = Math.max(box.top, Math.min(L.dotY, box.bottom));
        const dist = Math.hypot(nx - L.dotX, ny - L.dotY);
        if (dist <= ICON_R + 3) continue; // label hugs the dot — no line needed
        const ang = Math.atan2(ny - L.dotY, nx - L.dotX);
        const sx = L.dotX + Math.cos(ang) * ICON_R;
        const sy = L.dotY + Math.sin(ang) * ICON_R;
        // Pull the endpoint a hair into the box so it tucks under the text.
        const ex = nx - Math.cos(ang) * 1;
        const ey = ny - Math.sin(ang) * 1;
        ctx.strokeStyle = L.p.color;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // White halo behind the text keeps labels readable when a dense cluster
      // forces one to graze an icon or its own leader line.
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
}
