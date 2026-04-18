import { html, useMemo, useState } from '../html.js';
import { navigate } from '../router.js';

const CONDITIONS = [
  { slug: 'vanilla',     label: 'Vanilla',       short: 'Vanilla', skill: null },
  { slug: 'smith-alch',  label: 'Smith + Alch',  short: 'Smith',   skill: 'smithing' },
  { slug: 'fish',        label: 'Fish',          short: 'Fish',    skill: 'fishing' },
  { slug: 'fletch-alch', label: 'Fletch + Alch', short: 'Fletch',  skill: 'fletching' },
];

function goldIcon(skill, size) {
  const coinsSrc = VIEWS_BASE + 'coins.png';
  if (!skill) {
    return html`
      <span className="gold-icon coins-only" style=${{ width: size + 'px', height: size + 'px' }}>
        <img className="gold-icon-coins" src=${coinsSrc} alt="gold" />
      </span>
    `;
  }
  return html`
    <span className="gold-icon" style=${{ width: size + 'px', height: size + 'px' }}>
      <img className="gold-icon-skill" src=${VIEWS_BASE + 'skill-icons/' + skill + '.png'} width=${size} height=${size} alt="" />
      <img className="gold-icon-coins" src=${coinsSrc} alt="gold" />
    </span>
  `;
}

const TIERS = {
  zero: { bg: '#e8e8e8', color: '#aaa' },
  low:  { bg: '#fff3cd', color: '#7a5900' },
  mid:  { bg: '#ffd54f', color: '#6b4500' },
  high: { bg: '#ffb300', color: '#fff' },
};

function cellTier(gold, max) {
  if (!gold || max <= 0) return TIERS.zero;
  const t = gold / max;
  if (t >= 0.9) return TIERS.high;
  if (t >= 0.5) return TIERS.mid;
  if (t >  0)   return TIERS.low;
  return TIERS.zero;
}

function fmtGp(v) {
  if (v == null) return '—';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}

function fmt$(v) {
  if (v == null || v <= 0) return '—';
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}

export function GoldMatrix({ data }) {
  // 15m runs are smoke-test only and not shown in the index UI.
  const horizon = '30m';

  const rows = useMemo(() => {
    if (!data) return [];
    const byModel = new Map();

    for (const cond of CONDITIONS) {
      const slice = data[`${cond.slug}-${horizon}`] || {};
      for (const model of Object.keys(slice)) {
        const r = slice[model];
        if (!r) continue;
        if (!byModel.has(model)) {
          byModel.set(model, { key: model, cells: {}, total: 0 });
        }
        const row = byModel.get(model);
        row.cells[cond.slug] = r;
        row.total += r.gold || 0;
      }
    }

    return Array.from(byModel.values())
      .filter(r => MODEL_CONFIG[r.key])
      .sort((a, b) => b.total - a.total);
  }, [data, horizon]);

  const maxByCond = useMemo(() => {
    const m = {};
    for (const cond of CONDITIONS) {
      m[cond.slug] = Math.max(0, ...rows.map(r => r.cells[cond.slug]?.gold || 0));
    }
    return m;
  }, [rows]);

  if (!data || rows.length === 0) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Gold Accumulation</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Peak coins earned across four starting conditions — free-form money-making.
              <br />
              Scoring is <b>peak gold seen during the run</b> 
            </p>
          </div>
        </div>
        <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}>Model</th>
                ${CONDITIONS.map(c => html`
                  <th key=${c.slug} title=${c.label} style=${{ padding: '6px 10px' }}>
                    <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                      ${goldIcon(c.skill, 22)}
                      <span style=${{ fontSize: '10px', color: '#666', fontWeight: 500 }}>${c.short}</span>
                    </div>
                  </th>
                `)}
                <th style=${{ fontWeight: 700 }} className="heatmap-th-tip">
                  \u27e8ln\u27e9
                  <span className="tip-text">Average of ln(1 + gold) across the four conditions.</span>
                </th>
                <th style=${{ fontWeight: 700 }}>Total gp</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const cfg = MODEL_CONFIG[r.key];
                if (!cfg) return null;
                // ⟨ln⟩: mean of ln(1+gp) across conditions with data
                let logSum = 0, count = 0;
                for (const c of CONDITIONS) {
                  const cell = r.cells[c.slug];
                  if (cell) { logSum += Math.log(1 + (cell.gold || 0)); count++; }
                }
                const logMean = count > 0 ? logSum / count : 0;
                return html`
                  <tr key=${r.key}>
                    <td className="heatmap-model">
                      <img src=${cfg.icon} alt="" />
                      <span>${cfg.shortName}</span>
                    </td>
                    ${CONDITIONS.map(c => {
                      const cell = r.cells[c.slug];
                      const gold = cell?.gold || 0;
                      const peak = cell?.peakGold ?? gold;
                      const final = cell?.finalGold ?? gold;
                      const s = cellTier(gold, maxByCond[c.slug]);
                      const title = cell
                        ? (peak !== final
                            ? `peak ${peak} / final ${final} — click to open trajectory`
                            : `${gold} gp — click to open trajectory`)
                        : 'no data';
                      const hasTrajectory = !!(window.GOLD_TRAJECTORIES?.[r.key]?.[`gold-${c.slug}`]);
                      const clickable = hasTrajectory;
                      return html`
                        <td key=${c.slug}
                            title=${title}
                            onClick=${clickable ? () => navigate('trajectory/' + r.key + '/gold-' + c.slug) : undefined}
                            style=${{ background: s.bg, color: s.color, fontVariantNumeric: 'tabular-nums', fontSize: '11px', textAlign: 'right', cursor: clickable ? 'pointer' : 'default' }}>
                          ${cell ? fmtGp(gold) : ''}
                        </td>
                      `;
                    })}
                    <td className="heatmap-total" style=${{ fontVariantNumeric: 'tabular-nums' }}>${logMean.toFixed(1)}</td>
                    <td className="heatmap-total" style=${{ fontVariantNumeric: 'tabular-nums' }}>${fmtGp(r.total)}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}
