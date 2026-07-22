// Shared point-label placement for the scatter charts (CostScatter,
// ReleaseScatter). Labels prefer to sit immediately right of their dot and,
// under pressure, slide vertically along the dot's flank (then the left
// flank, then above/below) before ever jumping outward — so dense clusters
// resolve into tidy label columns instead of a ring of satellites. Distance
// from the dot is penalized without a cap, so a label only moves as far as an
// overlap actually forces it. Coordinate-descent sweeps let every label
// re-pick the cheapest spot given everyone else's current one, then a joint
// pass untangles any pair whose leader lines still cross. Labels pushed off
// their dot get a subtle gray leader line back to it.
//
// `points` is the array of plotted points in dataset order, each with
// { label, color } plus optional { big } (larger emphasized text), { alpha }
// (fade the label + leader line), and { ghost } (de-emphasized: its label and
// icon don't constrain non-ghost labels, though ghost labels still avoid
// everything). Returns a Chart.js plugin.

const LABEL_H = 12; // collision height of one label row
const BIG_LABEL_H = 18;

const BASE_FONT = '500 10.5px "Google Sans", sans-serif';
const BIG_FONT = '600 15.5px "Google Sans", sans-serif';
const fontFor = (p) => (p.big ? BIG_FONT : BASE_FONT);
const PAD = 2;      // breathing room between label boxes
const ICON_R = 13;  // keep-out radius around each point icon
const GAP = 4;      // gap between icon edge and flank labels

// Soften a hex color toward gray so labels read as annotations, not data.
const muteCache = new Map();
function mute(color) {
  let m = muteCache.get(color);
  if (m) return m;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const mix = (c) => Math.round(c + (118 - c) * 0.32); // 32% toward #767676
    m = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  } else {
    m = color;
  }
  muteCache.set(color, m);
  return m;
}

const boxOf = (L) => {
  const h = L.h || LABEL_H;
  return {
    left: L.left - PAD, right: L.left + L.w + PAD,
    top: L.y - h / 2 - PAD, bottom: L.y + h / 2 + PAD,
  };
};

const overlapArea = (a, b) => {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

// Segment intersection (proper crossings only) — used to keep leader lines
// from crossing each other, which is what makes dense clusters untraceable.
const orient = (ax, ay, bx, by, cx, cy) =>
  Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
const segsCross = (s, t) => {
  const o1 = orient(s.x1, s.y1, s.x2, s.y2, t.x1, t.y1);
  const o2 = orient(s.x1, s.y1, s.x2, s.y2, t.x2, t.y2);
  const o3 = orient(t.x1, t.y1, t.x2, t.y2, s.x1, s.y1);
  const o4 = orient(t.x1, t.y1, t.x2, t.y2, s.x2, s.y2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0;
};

// Does a segment pass through a rectangle? (Endpoint inside, or a proper
// crossing with any edge.)
const segHitsRect = (s, r) => {
  const inside = (x, y) => x > r.left && x < r.right && y > r.top && y < r.bottom;
  if (inside(s.x1, s.y1) || inside(s.x2, s.y2)) return true;
  const edges = [
    { x1: r.left, y1: r.top, x2: r.right, y2: r.top },
    { x1: r.right, y1: r.top, x2: r.right, y2: r.bottom },
    { x1: r.right, y1: r.bottom, x2: r.left, y2: r.bottom },
    { x1: r.left, y1: r.bottom, x2: r.left, y2: r.top },
  ];
  return edges.some((e) => segsCross(s, e));
};

// Leader segment for a label placement: dot center → nearest point on the
// label box. This mirrors exactly how the leader is drawn, so the crossing
// penalty judges the same lines the viewer sees.
const segOf = (L, c) => {
  const h = L.h || LABEL_H;
  return {
    x1: L.dotX, y1: L.dotY,
    x2: Math.max(c.left, Math.min(L.dotX, c.left + L.w)),
    y2: Math.max(c.y - h / 2, Math.min(L.dotY, c.y + h / 2)),
  };
};

function solve(ctx, chartArea, meta, points) {
  // Foreign-icon keep-out boxes are inflated a touch beyond the icon itself:
  // a label sitting flush against someone else's icon reads as attached to
  // it, so adjacency has to cost something too.
  const ICON_MARGIN = 4;
  const iconBoxes = meta.data.map((el) => ({
    left: el.x - ICON_R - ICON_MARGIN, right: el.x + ICON_R + ICON_MARGIN,
    top: el.y - ICON_R - ICON_MARGIN, bottom: el.y + ICON_R + ICON_MARGIN,
  }));

  const inBounds = (b) =>
    b.left >= chartArea.left && b.right <= chartArea.right &&
    b.top >= chartArea.top && b.bottom <= chartArea.bottom;

  const labels = [];
  meta.data.forEach((el, i) => {
    const p = points[i];
    if (!p) return;
    ctx.font = fontFor(p);
    const w = ctx.measureText(p.label).width;
    const h = p.big ? BIG_LABEL_H : LABEL_H;
    // `side` is a mild preference penalty: right flank reads best, left is
    // nearly as good, above/below and outward escapes cost a bit more so the
    // layout stays consistent when there's room.
    const mk = (dx, dy, align, side) => {
      const ax = el.x + dx;
      const left = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
      return { left, y: el.y + dy, align, anchorX: ax, d: Math.hypot(dx, dy), side };
    };
    const FLANK = ICON_R + GAP;
    const candidates = [];
    // Flank columns: slide vertically along the dot before moving away.
    for (const dy of [0, -7, 7, -14, 14, -21, 21, -28, 28, -36, 36]) {
      candidates.push(mk(FLANK, dy, 'left', 0));
      candidates.push(mk(-FLANK, dy, 'right', 3));
    }
    // Directly above / below.
    for (const dy of [ICON_R + 8, ICON_R + 15, ICON_R + 22]) {
      candidates.push(mk(0, -dy, 'center', 6));
      candidates.push(mk(0, dy, 'center', 6));
    }
    // Escape rings for the worst crowding — leader lines keep these tied to
    // their dot, but the distance penalty means they're a last resort.
    for (const dy of [0, -10, 10, -20, 20, -30, 30, -40, 40]) {
      candidates.push(mk(FLANK + 14, dy, 'left', 8));
      candidates.push(mk(-FLANK - 14, dy, 'right', 10));
    }
    for (const dy of [0, -14, 14, -28, 28, -42, 42]) {
      candidates.push(mk(FLANK + 30, dy, 'left', 12));
      candidates.push(mk(-FLANK - 30, dy, 'right', 14));
    }
    for (const dy of [0, -16, 16, -32, 32, -48, 48]) {
      candidates.push(mk(FLANK + 48, dy, 'left', 16));
      candidates.push(mk(-FLANK - 48, dy, 'right', 18));
    }
    const usable = candidates.filter((c) => inBounds(boxOf({ ...c, w, h })));
    if (usable.length === 0) usable.push(mk(FLANK, 0, 'left', 0));
    labels.push({ p, w, h, idx: i, dotX: el.x, dotY: el.y, candidates: usable, ...usable[0] });
  });

  // Cost of placing label k at candidate c. Overlap penalties are steep
  // enough that any overlap-free spot beats any overlapping one; among clear
  // spots, the uncapped distance term keeps every label as close to its own
  // dot as the crowd allows, and the side term breaks remaining ties toward a
  // consistent right-of-dot look.
  const costAt = (k, c) => {
    const box = boxOf({ ...c, w: labels[k].w, h: labels[k].h });
    const seg = segOf(labels[k], c);
    // Ghost points don't constrain non-ghost labels: the emphasized layout is
    // solved as if the de-emphasized crowd weren't there. Ghost labels still
    // pay full cost against everyone, so they flow around the priority layout.
    const kGhost = !!labels[k].p.ghost;
    let cost = c.d * 2.2 + c.side;
    for (let m = 0; m < labels.length; m++) {
      if (m === k) continue;
      if (!kGhost && labels[m].p.ghost) continue;
      const mBox = boxOf(labels[m]);
      cost += overlapArea(box, mBox) * 4;
      const mSeg = segOf(labels[m], labels[m]);
      if (segsCross(seg, mSeg)) cost += 150;
      // Leaders tunneling under someone else's label (or vice versa) read as
      // a false attachment — almost as bad as a crossing.
      if (segHitsRect(seg, mBox)) cost += 60;
      if (segHitsRect(mSeg, box)) cost += 60;
    }
    for (let j = 0; j < iconBoxes.length; j++) {
      if (j === labels[k].idx) continue;
      if (!kGhost && points[j] && points[j].ghost) continue;
      cost += overlapArea(box, iconBoxes[j]) * 6;
    }
    return cost;
  };

  for (let sweep = 0; sweep < 8; sweep++) {
    let improved = false;
    for (let k = 0; k < labels.length; k++) {
      const L = labels[k];
      let best = null;
      let bestCost = Infinity;
      for (const c of L.candidates) {
        const cost = costAt(k, c);
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      if (best && (best.left !== L.left || best.y !== L.y)) {
        Object.assign(L, best);
        improved = true;
      }
    }
    if (!improved) break;
  }

  // Uncrossing pass: coordinate descent moves one label at a time, so two
  // labels whose leaders cross can each be stuck — neither single move pays
  // off, but moving both at once does. For every crossing pair, jointly
  // search both candidate sets for the cheapest combined placement.
  const placementOf = (L) =>
    ({ left: L.left, y: L.y, align: L.align, anchorX: L.anchorX, d: L.d, side: L.side });
  for (let pass = 0; pass < 3; pass++) {
    let untangled = false;
    for (let k = 0; k < labels.length; k++) {
      for (let m = k + 1; m < labels.length; m++) {
        if (!segsCross(segOf(labels[k], labels[k]), segOf(labels[m], labels[m]))) continue;
        const cur = { ck: placementOf(labels[k]), cm: placementOf(labels[m]) };
        let best = cur;
        let bestCost = costAt(k, cur.ck) + costAt(m, cur.cm);
        for (const ck of labels[k].candidates) {
          Object.assign(labels[k], ck);
          for (const cm of labels[m].candidates) {
            Object.assign(labels[m], cm);
            const cost = costAt(k, ck) + costAt(m, cm);
            if (cost < bestCost - 1e-6) { bestCost = cost; best = { ck, cm }; }
          }
        }
        Object.assign(labels[k], best.ck);
        Object.assign(labels[m], best.cm);
        if (best !== cur) untangled = true;
      }
    }
    if (!untangled) break;
  }

  return labels;
}

export function makeLabelPlugin(points, id = 'pointLabels') {
  // The layout only depends on chart geometry, so cache the solved placements
  // and reuse them for pure redraws (hover highlights, tooltips).
  let cacheKey = null;
  let cached = null;

  return {
    id,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = BASE_FONT;
      ctx.textBaseline = 'middle';

      const key =
        `${chartArea.left},${chartArea.top},${chartArea.right},${chartArea.bottom}|` +
        meta.data.map((el) => `${el.x},${el.y}`).join(';') + '|' +
        points.map((p) => p && `${p.label}${p.big ? '!' : ''}${p.ghost ? '~' : ''}`).join(';');
      if (key !== cacheKey) {
        cached = solve(ctx, chartArea, meta, points);
        cacheKey = key;
      }
      const labels = cached;

      // Leader lines: draw from the icon edge to the nearest point of the
      // label box when the label sits clearly away from its dot. Neutral gray
      // so the tethers recede behind the data. Drawn first so the text +
      // white halo render on top.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(107, 107, 107, 0.45)';
      for (const L of labels) {
        ctx.globalAlpha = L.p.alpha != null ? L.p.alpha : 1;
        const box = {
          left: L.left, right: L.left + L.w,
          top: L.y - L.h / 2, bottom: L.y + L.h / 2,
        };
        // Nearest point on the (unpadded) label box to the dot center.
        const nx = Math.max(box.left, Math.min(L.dotX, box.right));
        const ny = Math.max(box.top, Math.min(L.dotY, box.bottom));
        const dist = Math.hypot(nx - L.dotX, ny - L.dotY);
        if (dist <= ICON_R + 4) continue; // label hugs the dot — no line needed
        const ang = Math.atan2(ny - L.dotY, nx - L.dotX);
        const sx = L.dotX + Math.cos(ang) * ICON_R;
        const sy = L.dotY + Math.sin(ang) * ICON_R;
        // Pull the endpoint a hair into the box so it tucks under the text.
        const ex = nx - Math.cos(ang) * 1;
        const ey = ny - Math.sin(ang) * 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }

      // White halo behind the text keeps labels readable when a dense cluster
      // forces one to graze an icon or a gridline.
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineJoin = 'round';
      for (const L of labels) {
        ctx.globalAlpha = L.p.alpha != null ? L.p.alpha : 1;
        ctx.font = fontFor(L.p);
        ctx.textAlign = L.align;
        ctx.strokeText(L.p.label, L.anchorX, L.y);
        ctx.fillStyle = mute(L.p.color);
        ctx.fillText(L.p.label, L.anchorX, L.y);
      }
      ctx.restore();
    },
  };
}
