import { html, useMemo, useState } from '../html.js';

// Per-1M-token pricing (input, cache read, output)
const PRICING = {
  opus:       { input: 5,    cache: 0.50,  output: 25 },
  opus45:     { input: 5,    cache: 0.50,  output: 25 },
  sonnet46:   { input: 3,    cache: 0.30,  output: 15 },
  sonnet45:   { input: 3,    cache: 0.30,  output: 15 },
  haiku:      { input: 1,    cache: 0.10,  output: 5 },
  codex53:    { input: 3,    cache: 0.75,  output: 15 },
  gpt54:      { input: 2.50, cache: 0.625, output: 15 },
  gemini:     { input: 2,    cache: 0.20,  output: 12 },
  gemini31:   { input: 2,    cache: 0.20,  output: 12 },
  geminiflash:{ input: 0.50, cache: 0.05,  output: 3 },
};

function computeCost(tokenUsage, pricing) {
  const { inputTokens, cacheTokens, outputTokens } = tokenUsage;
  const nonCacheInput = inputTokens - cacheTokens;
  return (nonCacheInput * pricing.input + cacheTokens * pricing.cache + outputTokens * pricing.output) / 1e6;
}

function fmt$(v) {
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
}

export function CostTable({ data }) {
  const [sortCol, setSortCol] = useState('logMean');
  const [sortAsc, setSortAsc] = useState(false);

  const models = useMemo(() => {
    if (!data) return [];

    return Object.keys(data)
      .filter(key => PRICING[key])
      .map(key => {
        const pricing = PRICING[key];
        let logSum = 0;
        let count = 0;
        let totalCost = 0;
        let totalXp = 0;
        let skillsWithCost = 0;
        let skillsWithXp = 0;
        let totalInput = 0;
        let totalCache = 0;
        let totalOutput = 0;

        for (const skill of SKILL_ORDER) {
          const sd = data[key]?.[skill];
          if (!sd) continue;
          const rate = sd.peakXpRate || 0;
          logSum += Math.log(1 + rate);
          count++;

          const tu = sd.tokenUsage;
          if (tu) {
            const cost = computeCost(tu, pricing);
            totalCost += cost;
            skillsWithCost++;
            totalInput += tu.inputTokens;
            totalCache += tu.cacheTokens;
            totalOutput += tu.outputTokens;
          }

          if (sd.finalXp > 0) {
            totalXp += sd.finalXp;
            skillsWithXp++;
          }
        }

        const logMean = count > 0 ? logSum / count : 0;
        const avgCost = skillsWithCost > 0 ? totalCost / skillsWithCost : 0;
        const costPer1kXp = totalXp > 0 ? totalCost / (totalXp / 1000) : Infinity;
        const cachePercent = totalInput > 0 ? (totalCache / totalInput) * 100 : 0;

        return {
          key,
          logMean,
          avgCost,
          costPer1kXp,
          totalInput,
          totalCache,
          totalOutput,
          cachePercent,
          skillsWithCost,
        };
      })
      .filter(m => m.skillsWithCost > 0);
  }, [data]);

  const sorted = useMemo(() => {
    const arr = models.slice();
    arr.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      // Infinity sorts last regardless of direction
      if (va === Infinity && vb === Infinity) return 0;
      if (va === Infinity) return 1;
      if (vb === Infinity) return -1;
      return sortAsc ? va - vb : vb - va;
    });
    return arr;
  }, [models, sortCol, sortAsc]);

  if (!data || sorted.length === 0) return null;

  function handleSort(col) {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      // Default descending for performance, ascending for cost
      setSortAsc(col === 'avgCost' || col === 'costPer1kXp');
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
            <h2 className="title is-3">Cost & Efficiency</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Estimated API cost per 30-min run based on token usage and public pricing.
              <br />
              Models without token data or pricing are omitted.
            </p>
          </div>
        </div>
        <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}>Model</th>
                <th className="sort-header" onClick=${() => handleSort('logMean')}>
                  Avg XP/min${sortIndicator('logMean')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('avgCost')}>
                  Avg Cost/Run${sortIndicator('avgCost')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('costPer1kXp')}>
                  Cost/1k XP${sortIndicator('costPer1kXp')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('totalInput')}>
                  Tokens (in/out)${sortIndicator('totalInput')}
                </th>
                <th className="sort-header" onClick=${() => handleSort('cachePercent')}>
                  Cache %${sortIndicator('cachePercent')}
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
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${m.costPer1kXp === Infinity ? '\u2014' : fmt$(m.costPer1kXp)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums', fontSize: '11px' }}>${fmtTokens(m.totalInput)} / ${fmtTokens(m.totalOutput)}</td>
                    <td style=${{ fontVariantNumeric: 'tabular-nums' }}>${m.cachePercent.toFixed(0)}%</td>
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
