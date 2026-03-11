import { html } from '../html.js';
import { useRoute } from '../router.js';
import { Hero } from './Hero.js';
import { Teaser } from './Teaser.js';
import { Overview } from './Overview.js';
import { CumulativeChart } from './CumulativeChart.js';
import { Heatmap } from './Heatmap.js';
import { AgentInterface } from './AgentInterface.js';
import { Footer } from './Footer.js';
import { TrajectoryModal } from './TrajectoryModal.js';
import { SkillPicker } from './SkillPicker.js';
import { InterestingTrajectories } from './InterestingTrajectories.js';

export function App() {
  const route = useRoute();
  const data = window.COMBINED_DATA || null;

  return html`
    <${React.Fragment}>
      <${Hero} />
      <${Teaser} />
      <${Overview} />
      <${AgentInterface} />
      <${CumulativeChart} data=${data} />
      <${Heatmap} data=${data} activeModel=${route.model} activeSkill=${route.skill} />
        <${TrajectoryModal} model=${route.model || 'opus'} skill=${route.skill || 'woodcutting'} data=${data} />
      <${InterestingTrajectories} data=${data} />

      <${Footer} />

      ${route.page === 'model' && html`
        <${SkillPicker} model=${route.model} data=${data} />
      `}
    </${React.Fragment}>
  `;
}
