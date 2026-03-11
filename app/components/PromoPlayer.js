import { html, useState, useEffect, useRef, useMemo } from '../html.js';

const SHOWCASES = [
  { model: 'geminiflash', skill: 'fishing' },
  { model: 'opus', skill: 'fletching' },
  { model: 'gpt54', skill: 'smithing' },
  { model: 'gemini31', skill: 'mining' },
];

function getAgentSteps(trajectory) {
  if (!trajectory) return [];
  return trajectory
    .filter(s => s.source !== 'tool' && s.text)
    .map(s => ({ text: s.text, ts: s.ts }));
}

function PromoCell({ trajData, model, skill }) {
  const [currentText, setCurrentText] = useState('');
  const videoRef = useRef(null);
  const videoOffsetRef = useRef(0);

  const videoSrc = trajData.videoUrl || (trajData.trialDir + '/verifier/recording.mp4');
  const config = MODEL_CONFIG[model] || { displayName: model };
  const skillName = SKILL_DISPLAY[skill] || skill;
  const steps = useMemo(() => getAgentSteps(trajData?.trajectory), [trajData]);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    videoEl.muted = true;

    function onMetadata() {
      let offset = 0;
      if (trajData.containerFinishedAt) {
        const finishedMs = new Date(trajData.containerFinishedAt).getTime();
        const realDuration = trajData.videoDuration || videoEl.duration;
        const videoStartWallclock = finishedMs - (realDuration * 1000);
        const syncTimestamp = trajData.firstStepAt || trajData.agentStartedAt;
        if (syncTimestamp) {
          const syncMs = new Date(syncTimestamp).getTime();
          offset = (syncMs - videoStartWallclock) / 1000;
        }
      }
      videoOffsetRef.current = Math.max(0, offset);
      const gameDuration = trajData.durationSeconds || (30 * 60);
      videoEl.currentTime = videoOffsetRef.current + gameDuration * 0.15;
      videoEl.playbackRate = 3;
      videoEl.play().catch(() => {});
    }

    videoEl.onloadedmetadata = onMetadata;
    if (videoEl.readyState >= 1) onMetadata();

    videoEl.ontimeupdate = () => {
      const agentTime = Math.max(0, videoEl.currentTime - videoOffsetRef.current);
      const gameDuration = trajData.durationSeconds || (30 * 60);
      const maxTime = videoOffsetRef.current + gameDuration;
      if (videoEl.currentTime > maxTime) {
        videoEl.pause();
        return;
      }
      let latest = '';
      for (const step of stepsRef.current) {
        if (step.ts != null && step.ts <= agentTime) {
          latest = step.text;
        }
      }
      setCurrentText(latest);
    };

    videoEl.load();

    return () => {
      videoEl.pause();
      videoEl.ontimeupdate = null;
      videoEl.onloadedmetadata = null;
    };
  }, [videoSrc]);

  const displayText = currentText && currentText.length > 200
    ? currentText.slice(0, 200) + '\u2026'
    : currentText;

  return html`
    <div className="promo-cell">
      <video ref=${videoRef}
             src=${videoSrc}
             muted
             playsInline
             preload="auto" />
      <div className="promo-overlay">
        ${displayText && html`
          <div className="promo-transcript" key=${displayText.slice(0, 40)}>
            ${displayText}
          </div>
        `}
        <div className="promo-meta">
          ${config.icon && html`<img src=${config.icon} />`}
          <span>${config.shortName || config.displayName}</span>
          <span style=${{ color: 'rgba(255,255,255,0.5)' }}>${'\u00b7'}</span>
          <img src=${VIEWS_BASE + 'skill-icons/' + skill + '.png'} />
          <span>${skillName}</span>
        </div>
      </div>
    </div>
  `;
}

export function PromoPlayer({ data }) {
  const available = useMemo(() => {
    if (!data) return [];
    return SHOWCASES.filter(s => {
      const td = data[s.model]?.[s.skill];
      return td && (td.videoUrl || (td.videoAvailable && td.trialDir));
    });
  }, [data]);

  const [mobileIndex, setMobileIndex] = useState(0);
  const gridRef = useRef(null);

  // Auto-cycle on mobile
  useEffect(() => {
    if (available.length <= 1) return;
    const mq = window.matchMedia('(max-width: 640px)');
    if (!mq.matches) return;
    const id = setInterval(() => {
      setMobileIndex(i => (i + 1) % available.length);
    }, 6000);
    return () => clearInterval(id);
  }, [available.length]);

  // Scroll to active cell on mobile
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const mq = window.matchMedia('(max-width: 640px)');
    if (!mq.matches) return;
    const cell = el.children[mobileIndex];
    if (cell) {
      el.scrollTo({ left: cell.offsetLeft, behavior: 'smooth' });
    }
  }, [mobileIndex]);

  if (available.length === 0) {
    return html`
      <section className="hero teaser">
        <div className="container is-max-desktop">
          <div className="hero-body">
            <img className="teaser-img"
                 src="https://raw.githubusercontent.com/MaxBittker/rs-sdk/main/server/content/title/promo.gif"
                 alt="rs-sdk demo" />

          </div>
        </div>
      </section>
    `;
  }

  return html`
    <section className="hero teaser">
      <div className="container is-fluid">
        <div className="hero-body">
          <div className="promo-grid" ref=${gridRef}>
            ${available.map((s, i) => html`
              <${PromoCell}
                key=${s.model + '-' + s.skill}
                trajData=${data[s.model][s.skill]}
                model=${s.model}
                skill=${s.skill} />
            `)}
          </div>
          <div className="promo-dots">
            ${available.map((_, i) => html`
              <button key=${i}
                className=${'promo-dot' + (i === mobileIndex ? ' active' : '')}
                onClick=${() => setMobileIndex(i)} />
            `)}
          </div>
        </div>
      </div>
    </section>
  `;
}
