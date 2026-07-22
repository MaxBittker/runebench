import { html, useMemo, useState } from '../html.js';
import { navigate } from '../router.js';


function formatNorm(v, pad) {
  return String(Math.round(v)).padStart(pad || 1, '\u2007');
}

const TIERS = {
  zero: { bg: '#e8e8e8', color: '#aaa' },
  low:  { bg: '#c8e6c9', color: '#2e5e3e' },
  mid:  { bg: '#81c784', color: '#1a3d1f' },
  high: { bg: '#43a047', color: '#fff' },
};

function cellTier(rate, maxRate) {
  if (rate <= 0 || maxRate <= 0) return TIERS.zero;
  const t = rate / maxRate;
  if (t >= 0.9) return TIERS.high;
  if (t >= 0.5) return TIERS.mid;
  return TIERS.low;
}

function peakRateAtHorizon(skillData, skill) {
  if (!skillData) return 0;
  return skillData.peakXpRate || 0;
}

export function Heatmap({ data, activeModel, activeSkill }) {
  const [sortCol, setSortCol] = useState('logMean');

  const { models, skillOrder, skillMax, skillPad } = useMemo(() => {
    if (!data) return { models: [], skillOrder: [], skillMax: {} };

    const models = Object.keys(data).map(key => {
      const skills = {};
      let sum = 0;
      let logSum = 0;
      let count = 0;
      for (const skill of SKILL_ORDER) {
        const rate = peakRateAtHorizon(data[key]?.[skill], skill);
        skills[skill] = rate;
        sum += rate;
        logSum += Math.log(1 + rate);
        count++;
      }
      return { key, avgRate: sum / count, logMean: logSum / count, skills };
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

    const skillMax = {};
    const skillPad = {};
    for (const skill of skillOrder) {
      skillMax[skill] = Math.max(...models.map(m => m.skills[skill]));
      const maxDigits = Math.max(...models.map(m => String(Math.round(m.skills[skill])).length));
      skillPad[skill] = maxDigits;
    }

    return { models, skillOrder, skillMax, skillPad };
  }, [data]);

  const sortedModels = useMemo(() => {
    const sorted = models.slice();
    if (sortCol === 'model') {
      sorted.sort((a, b) => {
        const an = MODEL_CONFIG[a.key]?.shortName || a.key;
        const bn = MODEL_CONFIG[b.key]?.shortName || b.key;
        return an.localeCompare(bn);
      });
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
                      <span>${cfg.shortName}</span>
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
                    <td className="heatmap-total">${m.logMean.toFixed(1)}</td>
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
