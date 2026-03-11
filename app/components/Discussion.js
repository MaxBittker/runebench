import { html } from '../html.js';

export function Discussion() {
  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered">
          <div className="column is-8">
            <div className="content">

              <h3 className="title is-4">Task Design</h3>
              <h4>Scoring: XP Rates as the goal</h4>
              <p>
                The originally task was to gain as much XP as possible for a skill within a fixed time window, but we found this approach punished exploration - The winning strategies were often a simple grind with as little stopping as possible. Because we wanted to reward interesting strategies and exploration, we landed on measuring max XP rate per 15 second window.

                By focusing on XP rate, we reward agents that discover higher-level strategies, beyond pure time-on-task. It was great seeing winning runs use many locations, tricks, and methods as they level up - models are incredible optimizers. 
</p>
              <h3 className="title is-4">Limitations</h3>
              <p>
                The biggest remaining issue with this task design is the long runtime. I experimented with shorter task duration, but it punished the models' tendancy to front-load planning (spending many minutes reading docs), as well as the slow inference rates for some models. The complexity of the environment and low sample size also lead to noise and false negatives that hurt the numberical accuracy of the comparison between models
              </p>
              <p>
                There is room to design interesting micro-tasks with shorter runtimes to make the benchmark easier to run and iterate on. The complexity of the environment and low sample counts likely contributed significant noise to the results.
              </p>
           

              <h3 className="title is-4">Harness Development</h3>
              <h4>Growing an API</h4>
              <p>
                The rs-sdk typescript library was developed through cycles of automated error analysis — I would run a batch of agents on a task, categorize failures and missing features, and use those to inform harness improvements. This was a really interesting way to "grow" an API layer between the agents and the game server.
              </p>

              <h3 className="title is-4">Future Work</h3>
              <h4>Multi-Agent Collaboration</h4>
              <p>
                Can two bots outperform a single agent? For example, one agent gathering raw materials while another processes them — splitting the supply chain to achieve a higher combined XP rate. It would be fascinating to test coordination, communication around an optimization task. This might take the form of one LLM agent scripting multiple players characters, or seperate LLMs communicating through in-game chat.
              </p>

              <h4>Knowledge Transfer</h4>
              <p>
                How well can an agent write a guide for another agent? Given one agent's experience training a skill, how well can it produce instructions that meaningfully improve a second agent's performance?
              </p>

              <h3>Contribution</h3>

              <p>
                We would love to see more people experimenting with  <a href="https://github.com/MaxBittker/rs-sdk">RS-SDK</a>! Join the <a href="https://discord.com/invite/3DcuU5cMJN">Discord</a> to get involved, there are many people doing interesting small scale experiments with harnesses and techniques.
              </p>

<br/>

              <h4>Thank you!</h4>
              Thanks to Rob Haisfield, Sean Lee, Christopher Settles, Alex Duffy, and Erik Quintanilla for critical feedback and input, and to LostCity and Harbor RL communities for providing critical open source ecosystem.


            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
