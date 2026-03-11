import { html, useEffect, useRef } from '../html.js';
import { WikiBrowser } from './WikiBrowser.js';

const EXAMPLE_CODE = `// Chop trees, dropping logs when inventory fills
while (true) {
  if (sdk.getInventory().length >= 27) {
    for (const item of sdk.getInventory())
      if (/log/i.test(item.name)) await sdk.sendDropItem(item.slot);
  }
  await bot.chopTree(/^tree$/i);
}`;

function CodeBlock({ code, lang }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && window.hljs) {
      ref.current.removeAttribute('data-highlighted');
      window.hljs.highlightElement(ref.current);
    }
  }, [code]);
  return html`<pre className="agent-code-pre"><code ref=${ref} className=${'language-' + lang}>${code}</code></pre>`;
}

export function AgentInterface() {
  return html`
    <section className="section">
      <div className="container is-max-desktop">
        <div className="columns is-centered has-text-centered">
          <div className="column is-four-fifths">
            <h2 className="title is-3">How Agents See the World</h2>
          </div>
        </div>

        <div className="agent-row">
          <div className="agent-row-text">
            <div className="agent-panel-label">TypeScript SDK</div>
            <p>Agents play the game by writing and executing TypeScript snippets against an emulated game server. The SDK provides access to reading game state and performing actions.</p>
          </div>
          <div className="agent-row-example">
            <${CodeBlock} code=${EXAMPLE_CODE} lang="javascript" />
          </div>
        </div>

        <div className="agent-row">
          <div className="agent-row-text">
            <div className="agent-panel-label">Game Knowledge</div>
            <p>Each agent is given a folder of markdown files extracted from the game wiki — skill guides, item stats, NPC locations, and quest walkthroughs. They can search the files to inform their strategy.</p>
          </div>
          <div className="agent-row-example">
            <${WikiBrowser} />
          </div>
        </div>
      </div>
    </section>
  `;
}
