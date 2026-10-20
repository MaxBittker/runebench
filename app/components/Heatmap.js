import { html, useMemo, useState } from '../html.js';
import { navigate } from '../router.js';


function formatNorm(v, pad) {
  return String(Math.round(v)).padStart(pad || 1, '\u2007');
}

export const TIERS = {
  zero: { bg: '#e8e8e8', color: '#aaa' },
  low:     { bg: '#c8e6c9', color: '#2e5e3e' },
  lowMid:  { bg: '#a5d6a7', color: '#234a2c' },
  mid:     { bg: '#81c784', color: '#1a3d1f' },
  midHigh: { bg: '#62b465', color: '#0f2a13' },
  high:    { bg: '#43a047', color: '#fff' },
};

function cellTier(rate, maxRate) {
  if (rate <= 0 || maxRate <= 0) return TIERS.zero;
  const t = rate / maxRate;
  if (t >= 0.9) return TIERS.high;
  if (t >= 0.75) return TIERS.midHigh;
  if (t >= 0.5) return TIERS.mid;
  if (t >= 0.25) return TIERS.lowMid;
  return TIERS.low;
}

function peakRateAtHorizon(skillData, skill) {
  if (!skillData) return 0;
  return skillData.peakXpRate || 0;
}

// Rows that are the same model under a different effort level, speed mode or
// provider pin (opus5-xhigh, gpt61sol-low, glm52-wandb, …) share a base key.
// The "best row per model" toggle keeps only the highest-⟨ln⟩ row of each.
const VARIANT_SUFFIX = /-(xhigh|high|medium|low|max|fast|apikey|wandb|prime)$/;

function baseModelKey(key) {
  return key.replace(VARIANT_SUFFIX, '');
}

// Label for a collapsed row: the base model's name, with no effort/mode tag.
function baseShortName(key) {
  const base = MODEL_CONFIG[baseModelKey(key)];
  if (base) return base.shortName;
  return MODEL_CONFIG[key].shortName.replace(/ (xh|xhigh|hi|high|med|medium|lo|low|max|fast)$/, '');
}

// $/run cells: log-scaled sequential ambers, a separate scale from the XP
// greens since price isn't a score (pale = cheap, dark = expensive).
const COST_STOPS = ['#fff3e0', '#ffcc80', '#fb8c00', '#bf360c'].map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
});

function costShade(t) {
  const x = Math.min(1, Math.max(0, t)) * (COST_STOPS.length - 1);
  const i = Math.min(COST_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const rgb = COST_STOPS[i].map((c, k) => Math.round(c + (COST_STOPS[i + 1][k] - c) * f));
  return { background: `rgb(${rgb.join(',')})`, color: t >= 0.6 ? '#fff' : '#5d3200' };
}

function fmtCost(v) {
  if (!(v > 0)) return '\u2014';
  return '$' + (v >= 10 ? v.toFixed(1) : v.toFixed(2));
}

export function Heatmap({ data, activeModel, activeSkill }) {
  const [sortCol, setSortCol] = useState('logMean');
  const [bestOnly, setBestOnly] = useState(false);

  const { allModels, skillOrder } = useMemo(() => {
    if (!data) return { allModels: [], skillOrder: [] };

    const models = Object.keys(data).map(key => {
      const skills = {};
      let sum = 0;
      let logSum = 0;
      let count = 0;
      let costSum = 0;
      let costRuns = 0;
      for (const skill of SKILL_ORDER) {
        const rate = peakRateAtHorizon(data[key]?.[skill], skill);
        skills[skill] = rate;
        sum += rate;
        logSum += Math.log(1 + rate);
        count++;
        const costUsd = data[key]?.[skill]?.tokenUsage?.costUsd;
        if (costUsd != null) {
          costSum += costUsd;
          costRuns++;
        }
      }
      const avgCost = costRuns > 0 ? costSum / costRuns : 0;
      return { key, avgRate: sum / count, logMean: logSum / count, avgCost, skills };
    });

    models.sort((a, b) => b.logMean - a.logMean);

    // Skills stay grouped with their category; categories and skills within
    // each category are both ordered by difficulty (fewest model zeros first).
    const SKILL_GROUPS = [
      ['attack', 'strength', 'hitpoints', 'defence'],
      ['magic', 'ranged'],
      ['woodcutting', 'thieving', 'mining', 'fishing', 'prayer', 'fletching'],
      ['firemaking', 'cooking', 'smithing', 'crafting'],
    ];
    const zeros = skill => models.filter(m => !(m.skills[skill] > 0)).length;
    const avgRate = skill => models.reduce((s, m) => s + m.skills[skill], 0) / models.length;
    const bySkillDifficulty = (a, b) =>
      (zeros(a) - zeros(b)) || (avgRate(b) - avgRate(a));
    const zeroAvg = g => g.reduce((s, sk) => s + zeros(sk), 0) / g.length;
    const skillOrder = SKILL_GROUPS
      .map(group => group.slice().sort(bySkillDifficulty))
      .sort((ga, gb) => zeroAvg(ga) - zeroAvg(gb))
      .flat();

    return { allModels: models.filter(m => MODEL_CONFIG[m.key]), skillOrder };
  }, [data]);

  // Column order stays fixed across the toggle; tier colours and padding
  // follow whichever rows are visible.
  const { models, skillMax, skillPad, costScale } = useMemo(() => {
    let models = allModels;
    if (bestOnly) {
      // allModels is sorted by logMean desc, so the first row seen per base wins.
      const seen = new Set();
      models = allModels.filter(m => {
        const base = baseModelKey(m.key);
        if (seen.has(base)) return false;
        seen.add(base);
        return true;
      });
    }
    const skillMax = {};
    const skillPad = {};
    for (const skill of skillOrder) {
      skillMax[skill] = Math.max(...models.map(m => m.skills[skill]));
      skillPad[skill] = Math.max(...models.map(m => String(Math.round(m.skills[skill])).length));
    }
    const logCosts = models.filter(m => m.avgCost > 0).map(m => Math.log(m.avgCost));
    const costScale = { lo: Math.min(...logCosts), hi: Math.max(...logCosts) };
    return { models, skillMax, skillPad, costScale };
  }, [allModels, skillOrder, bestOnly]);

  const hiddenCount = allModels.length - allModels
    .reduce((bases, m) => bases.add(baseModelKey(m.key)), new Set()).size;

  const sortedModels = useMemo(() => {
    const sorted = models.slice();
    if (sortCol === 'model') {
      sorted.sort((a, b) => {
        const an = MODEL_CONFIG[a.key]?.shortName || a.key;
        const bn = MODEL_CONFIG[b.key]?.shortName || b.key;
        return an.localeCompare(bn);
      });
    } else if (sortCol === 'avgCost') {
      sorted.sort((a, b) => (a.avgCost || Infinity) - (b.avgCost || Infinity));
    } else if (sortCol !== 'logMean') {
      sorted.sort((a, b) => (b.skills[sortCol] || 0) - (a.skills[sortCol] || 0) || b.logMean - a.logMean);
    }
    return sorted;
  }, [models, sortCol]);

  if (!data || models.length === 0) return null;

  // Default sort (logMean) shows no indicator.
  function sortedClass(col) {
    return sortCol === col && col !== 'logMean' ? ' is-sorted' : '';
  }

  function handleCellClick(modelKey, skill) {
    const sd = data[modelKey]?.[skill];
    if (sd?.hasTrajectory || sd?.trajectory?.length > 0) {
      navigate('trajectory/' + modelKey + '/' + skill);
    }
  }

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Per-Skill Breakdown</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Peak XP/min per skill.  
              Skills are ordered by difficulty.
              <br />
              <b>Best of 1,</b> Please read these numbers with a wide error margin.
            </p>
          </div>
        </div>
        ${hiddenCount > 0 && html`
          <div className="heatmap-controls">
            <label className="checkbox">
              <input
                type="checkbox"
                checked=${bestOnly}
                onChange=${(e) => setBestOnly(e.target.checked)}
              />
              Best row per model${bestOnly ? ` (${hiddenCount} variant rows hidden)` : ''}
            </label>
          </div>
        `}
        <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}
                    className=${'heatmap-th-sortable' + sortedClass('model')}
                    onClick=${() => setSortCol('model')}>
                  Model
                </th>
                ${skillOrder.map(skill => html`
                  <th key=${skill} title=${SKILL_DISPLAY[skill]}
                      className=${'heatmap-th-sortable' + sortedClass(skill)}
                      onClick=${() => setSortCol(skill)}>
                    <img src=${VIEWS_BASE + 'skill-icons/' + skill + '.png'}
                         alt=${SKILL_DISPLAY[skill]} width="16" height="16" />
                  </th>
                `)}
                <th style=${{ fontWeight: 700 }}
                    className=${'heatmap-th-tip heatmap-th-sortable'}
                    onClick=${() => setSortCol('logMean')}>
                  \u27e8ln\u27e9
                  <span className="tip-text">avg of ln(1 + XP/min) across skills</span>
                </th>
                ${bestOnly && html`
                  <th className=${'heatmap-th-tip heatmap-th-sortable' + sortedClass('avgCost')}
                      onClick=${() => setSortCol('avgCost')}>
                    $/run
                    <span className="tip-text">average API cost of one 30-min skill run</span>
                  </th>
                `}
              </tr>
            </thead>
            <tbody>
              ${sortedModels.map(m => {
                const cfg = MODEL_CONFIG[m.key];
                if (!cfg) return null;
                return html`
                  <tr key=${m.key}>
                    <td className="heatmap-model">
                      <img src=${cfg.icon} alt="" />
                      <span>${bestOnly ? baseShortName(m.key) : cfg.shortName}</span>
                    </td>
                    ${skillOrder.map(skill => {
                      const rate = m.skills[skill];
                      const s = cellTier(rate, skillMax[skill]);
                      const isActive = m.key === activeModel && skill === activeSkill;
                      return html`
                        <td key=${skill}
                            style=${{ background: s.bg, color: s.color, fontVariantNumeric: 'tabular-nums', cursor: 'pointer', fontSize: '11px', ...(isActive ? { outline: '2px solid #5b8def', outlineOffset: '-2px', zIndex: 1, position: 'relative' } : {}) }}
                            onClick=${() => handleCellClick(m.key, skill)}>
                          ${formatNorm(rate, skillPad[skill])}
                        </td>
                      `;
                    })}
                    <td className="heatmap-total">${m.logMean.toFixed(2)}</td>
                    ${bestOnly && html`
                      <td style=${{ fontVariantNumeric: 'tabular-nums', ...(m.avgCost > 0
                            ? costShade((Math.log(m.avgCost) - costScale.lo) / ((costScale.hi - costScale.lo) || 1))
                            : { background: TIERS.zero.bg, color: TIERS.zero.color }) }}>
                        ${fmtCost(m.avgCost)}
                      </td>
                    `}
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
