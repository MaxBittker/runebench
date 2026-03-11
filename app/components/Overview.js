import { html } from '../html.js';

export function Overview() {
  return html`
    <section className="section">
      <div className="container is-max-desktop">
        <div className="columns is-centered has-text-centered">
          <div className="column is-four-fifths">
            <div className="content has-text-justified">
              <p>
                <strong>Runebench</strong> evaluates AI coding agents on their ability to play RuneScape via a
                <a href="https://github.com/MaxBittker/rs-sdk"> typescript sdk</a>
                ${' '}and must accomplish tasks in the game world.  Measuring agent's behavior in an "orient, decide, act" loop provides interesting insights into their multi-step planning and problem solving capabilities in coding agents.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
