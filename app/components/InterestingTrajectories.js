import { html } from '../html.js';
import { navigate } from '../router.js';

const INTERESTING = [
  {
    model: 'geminiflash',
    skill: 'fishing',
    description: 'Gemini Flash discovers an incredibly efficient fishing strategy almost immediately, rapidly outpacing models with far more compute. A masterclass in doing more with less.',
  },
];

export function InterestingTrajectories({ data }) {
  if (!data) return null;

  // Only show entries whose data exists
  const entries = INTERESTING.filter(t => data[t.model]?.[t.skill]);
  if (entries.length === 0) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <h2 className="title is-3 has-text-centered">Interesting Trajectories</h2>
        <div className="interesting-list">
          ${entries.map((t, i) => {
            const mc = MODEL_CONFIG[t.model] || { displayName: t.model, color: '#999' };
            const skillName = SKILL_DISPLAY[t.skill] || t.skill;
            const skillIcon = VIEWS_BASE + 'skill-icons/' + t.skill + '.png';
            const modelIcon = mc.icon || '';
            return html`
              <div key=${i} className="interesting-item"
                   onClick=${() => navigate('trajectory/' + t.model + '/' + t.skill)}>
                <div className="interesting-item-header">
                  ${modelIcon && html`<img src=${modelIcon} />`}
                  <span>${mc.displayName}</span>
                  <span style=${{ color: '#aaa', fontWeight: 400 }}>\u2014</span>
                  <img src=${skillIcon} />
                  <span>${skillName}</span>
                </div>
                <div className="interesting-item-desc">${t.description}</div>
              </div>
            `;
          })}
        </div>
      </div>
    </section>
  `;
}
