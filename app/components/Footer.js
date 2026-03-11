import { html } from '../html.js';

export function Footer() {
  return html`
    <footer className="footer" style=${{ backgroundColor: '#f0f0f0', marginTop: '60px' }}>
      <div className="container">
        <div className="columns is-centered">
          <div className="column is-8">
            <div className="content has-text-centered" style=${{ fontSize: '0.85em', color: '#888' }}>
              <p>
                RuneBench is built on${' '}
                <a href="https://github.com/MaxBittker/rs-sdk">rs-sdk</a>,
                and <a href="https://github.com/LostCityRS/Server">LostCity</a> engine/client
              </p>
              <p>
                Benchmark inspiration from${' '}
                <a href="https://jackhopkins.github.io/factorio-learning-environment/versions/0.3.0.html">Factorio Learning Environment</a>
                ${' '}by Jack Hopkins et al.
              </p>
              <p>
                Benchmarks run using the <a href="https://harborframework.com/">Harbor</a> framework.
              </p>
              <p>
                Website template borrowed from <a href="https://nerfies.github.io">Nerfies</a>
                ${' '}licensed under${' '}
                <a rel="license" href="http://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>.
              </p>
            
            </div>
            <div className="content" style=${{ marginTop: '24px', background: '#f5f5f5', borderRadius: '8px', padding: '16px 20px', fontSize: '0.8em', fontFamily: 'monospace', color: '#555', whiteSpace: 'pre-wrap' }}>
${`@misc{bittker2026runebench,
  title   = {RuneBench: AI Agent Benchmark on RuneScape Gameplay Tasks},
  author  = {Max Bittker},
  year    = {2026},
  note    = {Websim}
}`}
            </div>
          </div>
        </div>
      </div>
    </footer>
  `;
}
