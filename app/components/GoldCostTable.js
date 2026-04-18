import { html, useMemo, useState } from '../html.js';

const CONDITIONS = ['vanilla', 'smith-alch', 'fish', 'fletch-alch'];

function fmt$(v) {
  if (v == null || v <= 0) return '—';
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}

function fmtTokens(n) {
  if (!n) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
}

function fmtGp(v) {
  if (v == null) return '—';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}

export function GoldCostTable({ data }) {
  // 15m runs are smoke-test only and not shown in the index UI.
  const horizon = '30m';
  const [sortCol, setSortCol] = useState('logMean');
  const [sortAsc, setSortAsc] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];
    const byModel = new Map();

    for (const cond of CONDITIONS) {
      const slice = data[`${cond}-${horizon}`] || {};
      for (const model of Object.keys(slice)) {
        const r = slice[model];
        if (!r) continue;
        if (!MODEL_CONFIG[model]) continue;
        if (!byModel.has(model)) {
          byModel.set(model, {
            key: model,
            totalGold: 0,
            totalCost: 0,
            logSum: 0,
            count: 0,
            totalIn: 0,
            totalCache: 0,
            totalOut: 0,
            tokenRuns: 0,
          });
        }
        const row = byModel.get(model);
        row.totalGold += r.gold || 0;
        row.logSum += Math.log(1 + (r.gold || 0));
        row.count++;
        const tu = r.tokenUsage;
        if (tu) {
          const c = tu.costUsd || 0;
          row.totalCost += c;
          row.totalIn += tu.inputTokens || 0;
          row.totalCache += tu.cacheTokens || 0;
          row.totalOut += tu.outputTokens || 0;
          row.tokenRuns++;
        }
      }
    }

    const arr = Array.from(byModel.values()).map(r => {
      const logMean = r.count > 0 ? r.logSum / r.count : 0;
      const avgCost = r.tokenRuns > 0 ? r.totalCost / r.tokenRuns : 0;
      const costPerKGp = r.totalGold > 0 ? r.totalCost / (r.totalGold / 1000) : Infinity;
      const cachePct = r.totalIn > 0 ? (r.totalCache / r.totalIn) * 100 : 0;
      return { ...r, logMean, avgCost, costPerKGp, cachePct };
    }).filter(r => r.tokenRuns > 0);

    arr.sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va === Infinity && vb === Infinity) return 0;
      if (va === Infinity) return 1;
      if (vb === Infinity) return -1;
      return sortAsc ? va - vb : vb - va;
    });
    return arr;
  }, [data, horizon, sortCol, sortAsc]);

  if (!data || rows.length === 0) return null;

  function handleSort(col) {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      // Defaults: ascending for cost columns, descending for performance.
      setSortAsc(col === 'avgCost' || col === 'costPerKGp');
    }
  }

  function sortIndicator(col) {
    if (sortCol !== col) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Gold Cost Efficiency</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Dollar cost per gold-task run, compared against log-average performance.
              <br />
              ⟨ln⟩ averages ln(1 + gp) across the four starting conditions.
            </p>
          </div>
        </div>
        <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}>Model</th>
                <th className="sort-header" onClick=${() => handleSort('logMean')}>
                  ⟨ln⟩ gp${sortIndicator('logMean')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('totalGold')}>
                  Total gp${sortIndicator('totalGold')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('avgCost')}>
                  Avg Cost/Run${sortIndicator('avgCost')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('totalCost')}>
                  Total Cost${sortIndicator('totalCost')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('costPerKGp')}>
                  Cost / 1k gp${sortIndicator('costPerKGp')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('totalIn')}
                    title="Average input / output tokens per run">
                  Avg Tokens/Run (in/out)${sortIndicator('totalIn')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('cachePct')}>
                  Cache %${sortIndicator('cachePct')}
                </th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const cfg = MODEL_CONFIG[r.key];
                if (!cfg) return null;
                return html`
                  <tr key=${r.key}>
                    <td className="heatmap-model">
                      <img src=${cfg.icon} alt="" />
                      <span>${cfg.shortName}</span>
                    </td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${r.logMean.toFixed(1)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${fmtGp(r.totalGold)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${fmt$(r.avgCost)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${fmt$(r.totalCost)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${r.costPerKGp === Infinity ? '—' : fmt$(r.costPerKGp)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', fontSize: '11px' }}>${r.tokenRuns > 0 ? fmtTokens(r.totalIn / r.tokenRuns) : '—'} / ${r.tokenRuns > 0 ? fmtTokens(r.totalOut / r.tokenRuns) : '—'}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${r.cachePct.toFixed(0)}%</td>
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
