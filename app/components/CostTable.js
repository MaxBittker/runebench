import { html, useMemo, useState } from '../html.js';
import { TIERS } from './Heatmap.js';

function fmt$(v) {
  if (v == null || v <= 0) return '—';
  return '$' + v.toFixed(2);
}

function fmtTokens(n) {
  if (!n) return '—';
  if (n >= 1e6) {
    const v = n / 1e6;
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + 'M';
  }
  if (n >= 1e3) {
    const v = n / 1e3;
    return (v >= 10 ? (Math.round(v / 10) * 10) : v.toFixed(1)) + 'k';
  }
  return String(Math.round(n));
}

const COLLAPSED_ROWS = 13;

// Continuous shading through the skill heatmap's greens (light → mid → dark).
// t is goodness in [0, 1]; values outside the scale clamp to the ends.
const GREEN_STOPS = [TIERS.low.bg, TIERS.mid.bg, TIERS.high.bg].map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
});

function shade(t) {
  const x = Math.min(1, Math.max(0, t)) * (GREEN_STOPS.length - 1);
  const i = Math.min(GREEN_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const rgb = GREEN_STOPS[i].map((c, k) => Math.round(c + (GREEN_STOPS[i + 1][k] - c) * f));
  return { bg: `rgb(${rgb.join(',')})`, color: t >= 0.9 ? TIERS.high.color : TIERS.mid.color };
}

export function CostTable({ data }) {
  const [sortCol, setSortCol] = useState('logMean');
  const [sortAsc, setSortAsc] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];

    const out = [];
    for (const key of Object.keys(data)) {
      if (!MODEL_CONFIG[key]) continue;
      let logSum = 0;
      let rateCount = 0;
      let totalCost = 0;
      let runsWithCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalTurns = 0;
      let runsWithTurns = 0;

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
          totalInput += tu.inputTokens || 0;
          totalOutput += tu.outputTokens || 0;
        }

        // Prefer the exact extract-time count (pre-cap); fall back to counting
        // the (200-step-capped) embedded trajectory for older extracts.
        if (sd.toolCalls != null) {
          totalTurns += sd.toolCalls;
          runsWithTurns++;
        } else if (Array.isArray(sd.trajectory) && sd.trajectory.length > 0) {
          totalTurns += sd.trajectory.filter((s) => s.source === 'tool').length;
          runsWithTurns++;
        }
      }

      // Partial sweeps (e.g. gpt4o, woodcutting only) would be log-averaged
      // over a subset of skills; only rank models with all 16 runs.
      if (rateCount < SKILL_ORDER.length) continue;

      const logMean = logSum / rateCount;
      const avgCost = runsWithCost > 0 ? totalCost / runsWithCost : 0;

      out.push({
        key,
        logMean,
        avgCost,
        totalInput,
        totalOutput,
        runsWithCost,
        avgTurns: runsWithTurns > 0 ? totalTurns / runsWithTurns : 0,
      });
    }
    return out;
  }, [data]);

  const sorted = useMemo(() => {
    const arr = rows.slice();
    arr.sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va === Infinity && vb === Infinity) return 0;
      if (va === Infinity) return 1;
      if (vb === Infinity) return -1;
      return sortAsc ? va - vb : vb - va;
    });
    return arr;
  }, [rows, sortCol, sortAsc]);

  // Shading scale spans only the models shown by default (top COLLAPSED_ROWS by
  // score): the weakest of them is lightest, the best darkest. Cost is scaled
  // in log space (cheapest = darkest) since it spans ~10x even within that set.
  const scale = useMemo(() => {
    const top = rows.slice().sort((a, b) => b.logMean - a.logMean).slice(0, COLLAPSED_ROWS);
    const scores = top.map((r) => r.logMean);
    const logCosts = top.filter((r) => r.avgCost > 0).map((r) => Math.log(r.avgCost));
    return {
      scoreLo: Math.min(...scores),
      scoreHi: Math.max(...scores),
      costLo: Math.min(...logCosts),
      costHi: Math.max(...logCosts),
    };
  }, [rows]);

  if (!data || sorted.length === 0) return null;

  function handleSort(col) {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(col === 'avgCost');
    }
  }

  function sortIndicator(col) {
    if (sortCol !== col) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS);
  const hasMore = sorted.length > COLLAPSED_ROWS;

  return html`
    <div>
      <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}>Model</th>
                <th className="sort-header" onClick=${() => handleSort('logMean')}>
                  ⟨ln⟩ XP/min${sortIndicator('logMean')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('avgCost')}>
                  Avg Cost/Run${sortIndicator('avgCost')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('totalInput')}
                    title="Average input / output tokens per run">
                  Avg Tokens/Run (in/out)${sortIndicator('totalInput')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('avgTurns')}
                    title="Average tool calls per run">
                  Avg Tool Calls/Run${sortIndicator('avgTurns')}
                </th>
              </tr>
            </thead>
            <tbody>
              ${visible.map(m => {
                const cfg = MODEL_CONFIG[m.key];
                if (!cfg) return null;
                const scoreTier = shade((m.logMean - scale.scoreLo) / ((scale.scoreHi - scale.scoreLo) || 1));
                const costTier = m.avgCost > 0
                  ? shade((scale.costHi - Math.log(m.avgCost)) / ((scale.costHi - scale.costLo) || 1))
                  : TIERS.zero;
                return html`
                  <tr key=${m.key}>
                    <td className="heatmap-model">
                      <img src=${cfg.icon} alt="" />
                      <span>${cfg.shortName}</span>
                    </td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', background: scoreTier.bg, color: scoreTier.color }}>${m.logMean.toFixed(1)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', background: costTier.bg, color: costTier.color }}>${fmt$(m.avgCost)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', fontSize: '11px' }}>${m.runsWithCost > 0 ? fmtTokens(m.totalInput / m.runsWithCost) : '—'} / ${m.runsWithCost > 0 ? fmtTokens(m.totalOutput / m.runsWithCost) : '—'}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${m.avgTurns > 0 ? Math.round(m.avgTurns) : '—'}</td>
                  </tr>
                `;
              })}
              ${hasMore && html`
                <tr key="expand-toggle">
                  <td colSpan="5" style=${{ padding: 0 }}>
                    <button
                      className="button is-small is-ghost is-fullwidth"
                      style=${{ fontSize: '11px', color: '#888', textDecoration: 'none' }}
                      onClick=${() => setExpanded(!expanded)}
                    >
                      ${expanded ? `Show top ${COLLAPSED_ROWS} ▲` : `Show all ${sorted.length} models ▼`}
                    </button>
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
    </div>
  `;
}
