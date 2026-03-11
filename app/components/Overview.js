import { html } from '../html.js';

export function Overview() {
  return html`
    <section className="section">
      <div className="container is-max-desktop">
        <div className="columns is-centered has-text-centered">
          <div className="column is-four-fifths">
            <h2 className="title is-3">Overview</h2>
            <div className="content has-text-justified">
              <p>
                <strong>runescape-bench</strong> evaluates AI coding agents on their ability to play RuneScape.
                Agents are given access to a game environment via${' '}
                <a href="https://github.com/MaxBittker/rs-sdk">rs-sdk</a>
                ${' '}and must write code to accomplish tasks in the game world.
                The benchmark tests the agent's capabilities in a "observe, orient, decide, act loop" environment,
                surfacing differences in their multi-step planning and problem solving capabilities. It simulates 4 hour of playtime per skill.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
