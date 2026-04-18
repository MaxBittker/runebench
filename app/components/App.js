import { html } from '../html.js';
import { useRoute } from '../router.js';
import { Hero } from './Hero.js';
import { PromoPlayer } from './PromoPlayer.js';
import { Overview } from './Overview.js';
import { CumulativeChart } from './CumulativeChart.js';
import { Heatmap } from './Heatmap.js';
import { GoldMatrix } from './GoldMatrix.js';
import { GoldCostTable } from './GoldCostTable.js';
import { CostTable } from './CostTable.js';
import { AgentInterface } from './AgentInterface.js';
import { Footer } from './Footer.js';
import { TrajectoryModal } from './TrajectoryModal.js';

import { InterestingTrajectories } from './InterestingTrajectories.js';
import { Discussion } from './Discussion.js';

export function App() {
  const route = useRoute();
  const data = window.COMBINED_DATA || null;
  const goldData = window.GOLD_DATA || null;

  // Merge gold trajectory payloads into the skill data so TrajectoryModal can
  // reach them via data[model]["gold-<condition>"]. We only do this once,
  // idempotently — subsequent calls are no-ops.
  if (data && window.GOLD_TRAJECTORIES && !data.__goldMerged) {
    for (const [model, byCond] of Object.entries(window.GOLD_TRAJECTORIES)) {
      if (!data[model]) data[model] = {};
      for (const [cond, trial] of Object.entries(byCond)) {
        data[model][cond] = trial;
      }
    }
    data.__goldMerged = true;
  }

  return html`
    <${React.Fragment}>
      <${Hero} />
      <${PromoPlayer} data=${data} />
      <${Overview} />
      <${AgentInterface} />
      <${CumulativeChart} data=${data} />
      <${Heatmap} data=${data} activeModel=${route.model} activeSkill=${route.skill} />
      <${CostTable} data=${data} />
      <!-- <${GoldMatrix} data=${goldData} /> -->
      <!-- <${GoldCostTable} data=${goldData} /> -->
        <${TrajectoryModal} model=${route.model || 'opus'} skill=${route.skill || 'woodcutting'} data=${data} seekTs=${route.seekTs} />
      <${InterestingTrajectories} data=${data} />
      <${Discussion} />

      <${Footer} />


    </${React.Fragment}>
  `;
}
