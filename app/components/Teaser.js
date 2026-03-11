import { html } from '../html.js';

export function Teaser() {
  return html`
    <section className="hero teaser">
      <div className="container is-max-desktop">
        <div className="hero-body">
          <img className="teaser-img"
               src="https://raw.githubusercontent.com/MaxBittker/rs-sdk/main/server/content/title/promo.gif"
               alt="rs-sdk demo" />
          <p className="subtitle is-6 has-text-centered" style=${{ marginTop: '1rem' }}>
            Agents write code to play RuneScape — training skills
            and navigating the game world.
          </p>
        </div>
      </div>
    </section>
  `;
}
