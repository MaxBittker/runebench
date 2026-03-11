import { html } from '../html.js';
import { useRoute } from '../router.js';
import { Hero } from './Hero.js';
import { PromoPlayer } from './PromoPlayer.js';
import { Overview } from './Overview.js';
import { CumulativeChart } from './CumulativeChart.js';
import { Heatmap } from './Heatmap.js';
import { AgentInterface } from './AgentInterface.js';
import { Footer } from './Footer.js';
import { TrajectoryModal } from './TrajectoryModal.js';

import { InterestingTrajectories } from './InterestingTrajectories.js';
import { Discussion } from './Discussion.js';

export function App() {
  const route = useRoute();
  const data = window.COMBINED_DATA || null;

  return html`
    <${React.Fragment}>
      <${Hero} />
      <${PromoPlayer} data=${data} />
      <${Overview} />
      <${AgentInterface} />
      <${CumulativeChart} data=${data} />
      <${Heatmap} data=${data} activeModel=${route.model} activeSkill=${route.skill} />
        <${TrajectoryModal} model=${route.model || 'opus'} skill=${route.skill || 'woodcutting'} data=${data} seekTs=${route.seekTs} />
      <${InterestingTrajectories} data=${data} />
      <${Discussion} />

      <${Footer} />


    </${React.Fragment}>
  `;
}
