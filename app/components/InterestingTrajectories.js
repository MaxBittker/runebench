import { html } from '../html.js';
import { navigate } from '../router.js';

const INTERESTING = [
  {
    model: 'geminiflash',
    skill: 'fishing',
    description: 'Gemini Flash tries 4 different fishing techniques, selling fish to pay for bait and efficiently exploring options.',
    quote: 'Fly fishing at Barbarian Village is far superior for peak XP, so I\'m heading to Harry\'s Fishing Shop in Catherby to sell my swordfish and tuna for feathers.',
    moments: [
      { ts: 44, label: 'net fishing at Draynor' },
      { ts: 337, label: 'fly fishing at Barbarian Village' },
      { ts: 729, label: 'harpoon fishing' },
    ],
  },
  {
    model: 'opus',
    skill: 'fletching',
    description: 'Opus 4.6 needs a knife to fletch but doesn\'t have one. It checks wiki, tries shops, reads game source to find spawn locations, and problem-solves its way to one.',
    quote: 'Only 1/128 chance for a knife drop \u2014 too rare. Let me find a more reliable source.',
    moments: [
      { ts: 29, label: 'Realizes it needs a knife' },
      { ts: 406, label: 'Finds muggers drop knives' },
      { ts: 600, label: 'Starts fletching' },
    ],
  },
  {
    model: 'sonnet45',
    skill: 'smithing',
    description: 'Sonnet 4.5 tries to write a single mega-script that mines, smelts, and smiths all at once. Rewrites it over and over but never validates the basics, ending 30 minutes with 0 XP.',
    quote: 'The session serves as a reminder to validate each step of a process works independently before combining them into a larger system.',
    moments: [],
  },
  {
    model: 'gpt54',
    skill: 'smithing',
    description: 'GPT-5.4 reverse-engineers the tracker\'s 15-second sample windows and times its smithing bursts to land right after each tick, methodically optimizing bar spend patterns to push its peak XP rate higher each cycle.',
    quote: 'The synced burst landed exactly after the 20:27:11 tracker sample. I need the next sample at 20:27:26 to flush that burst into the rate calculation.',
    moments: [
      { ts: 761, label: 'First baseline' },
      { ts: 897, label: 'Syncs to tracker tick' },
      { ts: 1267, label: 'Considers iron for higher ceiling' },
    ],
  },
  {
    model: 'gemini31',
    skill: 'mining',
    description: 'Gemini 3.1 mines to level 75 and ventures into the Dwarven Mine seeking better ore. Stumbles into the wilderness, dies to Ice Giants, but recovers and gets back to work.',
    quote: 'I\'ve got a critical update: the bot experienced a fatal error \u2013 a simulated "death" scenario at location (2948, 3905), which, notably, is the Asgarnian Ice Dungeon!',
    moments: [
      { ts: 449, label: 'Seeks Runite' },
      { ts: 689, label: 'Dies in deep wildy' },
      { ts: 815, label: 'Recovers and resumes training' },
    ],
  },
];

function formatMomentTs(ts) {
  const m = Math.floor(ts / 60);
  const s = Math.floor(ts % 60);
  return m + ':' + String(s).padStart(2, '0');
}

export function InterestingTrajectories({ data }) {
  if (!data) return null;

  const entries = INTERESTING.filter(t => data[t.model]?.[t.skill]);
  if (entries.length === 0) return null;

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <h2 className="title is-3 has-text-centered">Interesting Trajectories</h2>
        <div className="interesting-grid">
          ${entries.map((t, i) => {
            const mc = MODEL_CONFIG[t.model] || { displayName: t.model, color: '#999' };
            const skillName = SKILL_DISPLAY[t.skill] || t.skill;
            const skillIcon = VIEWS_BASE + 'skill-icons/' + t.skill + '.png';
            const modelIcon = mc.icon || '';
            const basePath = 'trajectory/' + t.model + '/' + t.skill;
            return html`
              <div key=${i} className="interesting-card"
                   onClick=${() => navigate(basePath)}>
                <div className="interesting-card-header">
                  ${modelIcon && html`<img src=${modelIcon} />`}
                  <span>${mc.shortName || mc.displayName}</span>
                  <span style=${{ color: '#bbb', fontWeight: 400 }}>\u00b7</span>
                  <img src=${skillIcon} />
                  <span>${skillName}</span>
                </div>
                <div className="interesting-card-desc">${t.description}</div>
                ${t.quote && html`
                  <blockquote className="interesting-card-quote">${t.quote}</blockquote>
                `}
                ${t.moments && t.moments.length > 0 && html`
                  <div className="interesting-moments">
                    ${t.moments.map((m, j) => html`
                      <a key=${j} className="interesting-moment"
                         onClick=${(e) => { e.stopPropagation(); navigate(basePath + '@' + m.ts); }}>
                        <span className="interesting-moment-ts">${formatMomentTs(m.ts)}</span>
                        ${' ' + m.label}
                      </a>
                    `)}
                  </div>
                `}
              </div>
            `;
          })}
        </div>
      </div>
    </section>
  `;
}
