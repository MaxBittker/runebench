import { html } from '../html.js';

export function Hero() {
  return html`
    <section className="hero">
      <div className="hero-body">
        <div className="container is-max-desktop">
          <div className="columns is-centered">
            <div className="column has-text-centered">
              <h1 className="title is-1 publication-title">Runescape-Bench</h1>
              <p className="subtitle is-3" style=${{ marginTop: '-0.5rem', marginBottom: 0 }}>
                Agent Benchmark on RuneScape Gameplay Tasks
              </p>

              <div className="column has-text-centered">
                <div className="publication-links" style=${{ gap: '8px', display: 'flex', justifyContent: 'center' }}>
                  <span className="link-block">
                    <a href="https://github.com/MaxBittker/runescape-bench" target="_blank"
                       className="external-link button is-normal is-rounded is-dark">
                      <span className="icon">
                        <i className="fab fa-github"></i>
                      </span>
                      <span>Code</span>
                    </a>
                  </span>
                  <span className="link-block">
                    <a href="https://github.com/MaxBittker/rs-sdk" target="_blank"
                       className="external-link button is-normal is-rounded is-dark">
                      <span className="icon">
                        <img src="views/skill-icons/smithing.png" alt=""
                             style=${{ width: '18px', height: '18px', filter: 'brightness(0) invert(1)' }} />
                      </span>
                      <span>rs-sdk</span>
                    </a>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
