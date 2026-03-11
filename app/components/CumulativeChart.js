import { html, useEffect, useRef, useState } from '../html.js';
import { navigate } from '../router.js';

export function CumulativeChart({ data }) {
  const chartRef = useRef(null);
  const legendRef = useRef(null);
  const labelRef = useRef(null);
  const [pinnedSkill, setPinnedSkill] = useState(null);
  const [hoveredSkill, setHoveredSkill] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);

  const activeSkill = selectedModel ? null : ((hoveredSkill && hoveredSkill !== '__total__') ? hoveredSkill : pinnedSkill);
  const selectedConfig = selectedModel ? (MODEL_CONFIG[selectedModel] || { displayName: selectedModel }) : null;
  const activeLabel = selectedModel
    ? `${selectedConfig.displayName} \u2014 Per-Skill Peak Rate`
    : activeSkill ? `${SKILL_DISPLAY[activeSkill] || activeSkill} Peak Rate` : 'Average';

  useEffect(() => {
    if (!data || !chartRef.current || !legendRef.current || !labelRef.current) return;
    if (!window.renderCumulativeChart) return;

    chartRef.current.innerHTML = '';
    legendRef.current.innerHTML = '';

    renderCumulativeChart({
      canvasContainer: chartRef.current,
      legendContainer: legendRef.current,
      labelContainer: labelRef.current,
      data,
      horizonMinutes: 30,
      activeSkill,
      selectedModel,
      onLegendClick: (model) => setSelectedModel(model),
      onClick: selectedModel
        ? function(skillKey) { navigate('trajectory/' + selectedModel + '/' + skillKey); }
        : function(modelKey) {
            if (activeSkill) navigate('trajectory/' + modelKey + '/' + activeSkill);
            else setSelectedModel(modelKey);
          },
    });
  }, [data, activeSkill, selectedModel]);

  if (!data) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Peak XP Rate Over Time</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Peak XP/min across 16 skills over 30 minutes of accelerated playtime, equivalent to 4 hours   

            </p>
          </div>
        </div>
        <div className="benchmark-chart-wrap benchmark-chart-layout" style=${{ paddingTop: '0px' }}>
          <aside className="skill-rail" aria-label="Skill chart filter">
            <div
              className="skill-rail-grid"
              onMouseLeave=${() => setHoveredSkill(null)}
            >
              <button
                type="button"
                className=${`skill-rail-reset${!selectedModel && !pinnedSkill ? ' active' : ''}${hoveredSkill === '__total__' ? ' hovered' : ''}`}
                onClick=${() => { if (selectedModel) { setSelectedModel(null); } setPinnedSkill(null); setHoveredSkill(null); }}
                onMouseEnter=${() => { if (pinnedSkill || selectedModel) setHoveredSkill('__total__'); }}
                onMouseLeave=${() => { if (hoveredSkill === '__total__') setHoveredSkill(null); }}
              >
                Average
              </button>
              ${SKILL_ORDER.map((skill) => {
                const label = SKILL_DISPLAY[skill] || skill;
                const iconSrc = VIEWS_BASE + 'skill-icons/' + skill + '.png';
                const isPinned = !selectedModel && pinnedSkill === skill;
                const isHovered = !selectedModel && hoveredSkill === skill;
                const className = [
                  'skill-rail-item',
                  isPinned ? ' active-hard' : '',
                  isHovered ? ' active-soft' : '',
                ].filter(Boolean).join(' ');
                return html`
                  <button
                    key=${skill}
                    type="button"
                    className=${className}
                    title=${label}
                    aria-label=${label}
                    onMouseEnter=${() => { if (!selectedModel) setHoveredSkill(skill); }}
                    onFocus=${() => { if (!selectedModel) setHoveredSkill(skill); }}
                    onClick=${() => {
                      if (selectedModel) {
                        setSelectedModel(null);
                        setPinnedSkill(skill);
                        setHoveredSkill(null);
                      } else {
                        setPinnedSkill((current) => current === skill ? null : skill);
                        setHoveredSkill(null);
                      }
                    }}
                  >
                    <img src=${iconSrc} alt=${label} />
                  </button>
                `;
              })}
            </div>
          </aside>
          <div className="benchmark-chart-main">
            <div className="benchmark-chart-label" ref=${labelRef}>${activeLabel}</div>
            <div ref=${chartRef}></div>
          </div>
        </div>
        <div className="bottom-legend" ref=${legendRef}></div>
      </div>
    </section>
  `;
}
