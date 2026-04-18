import { html, useMemo, useState } from '../html.js';

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

export function CostTable({ data }) {
  const [sortCol, setSortCol] = useState('logMean');
  const [sortAsc, setSortAsc] = useState(false);

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
      }

      if (rateCount === 0) continue;

      const logMean = logSum / rateCount;
      const avgCost = runsWithCost > 0 ? totalCost / runsWithCost : 0;

      out.push({
        key,
        logMean,
        avgCost,
        totalInput,
        totalOutput,
        runsWithCost,
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

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Skill Cost Efficiency</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Average API cost per 30-min skill run vs. log-average performance across 16 skills.
              <br />
              ⟨ln⟩ averages ln(1 + peak XP/min). Click any header to sort.
            </p>
          </div>
        </div>
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
              </tr>
            </thead>
            <tbody>
              ${sorted.map(m => {
                const cfg = MODEL_CONFIG[m.key];
                if (!cfg) return null;
                return html`
                  <tr key=${m.key}>
                    <td className="heatmap-model">
                      <img src=${cfg.icon} alt="" />
                      <span>${cfg.shortName}</span>
                    </td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${m.logMean.toFixed(1)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${fmt$(m.avgCost)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', fontSize: '11px' }}>${m.runsWithCost > 0 ? fmtTokens(m.totalInput / m.runsWithCost) : '—'} / ${m.runsWithCost > 0 ? fmtTokens(m.totalOutput / m.runsWithCost) : '—'}</td>
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
