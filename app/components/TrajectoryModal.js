import { html, useState, useEffect, useRef, useCallback, useMemo } from '../html.js';
import { navigate } from '../router.js';

const TIERS = {
  zero: { bg: 'rgba(200,200,200,0.2)' },
  low:  { bg: 'rgba(200,230,201,0.3)' },
  mid:  { bg: 'rgba(129,199,132,0.3)' },
  high: { bg: 'rgba(67,160,71,0.3)' },
};

function cellTier(rate, maxRate) {
  if (rate <= 0 || maxRate <= 0) return TIERS.zero;
  const t = rate / maxRate;
  if (t >= 0.9) return TIERS.high;
  if (t >= 0.5) return TIERS.mid;
  return TIERS.low;
}

const SKILL_COLORS = {
  attack:'#e04040', defence:'#6090d0', strength:'#40a040', hitpoints:'#d04070',
  ranged:'#50b050', prayer:'#d0d060', magic:'#6060d0', woodcutting:'#8b6040',
  fishing:'#40a0c0', mining:'#a07840', cooking:'#b04080', fletching:'#408060',
  crafting:'#c09040', smithing:'#707070', firemaking:'#e08020', thieving:'#a040a0',
};

function formatTimestamp(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function findSkillLevel(sample, skillKey) {
  if (!sample?.skills) return 1;
  const skillName = SKILL_DISPLAY[skillKey] || skillKey;
  for (const [sName, sData] of Object.entries(sample.skills)) {
    if (sName.toLowerCase() === skillKey || sName.toLowerCase() === skillName.toLowerCase()) {
      return sData.level || 1;
    }
  }
  return 1;
}

function findSkillXp(sample, skillKey) {
  if (!sample?.skills) return 0;
  const skillName = SKILL_DISPLAY[skillKey] || skillKey;
  for (const [sName, sData] of Object.entries(sample.skills)) {
    if (sName.toLowerCase() === skillKey || sName.toLowerCase() === skillName.toLowerCase()) {
      return sData.xp || 0;
    }
  }
  return 0;
}

function computeRateData(samples, skillKey) {
  const rates = [];    // { x: minutes, y: XP/min }
  const peakRates = []; // { x: minutes, y: running max XP/min }
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dxp = findSkillXp(curr, skillKey) - findSkillXp(prev, skillKey);
    const dms = curr.elapsedMs - prev.elapsedMs;
    if (dms <= 0) continue;
    const rate = (dxp / dms) * 60000 / 8 / 25; // real-game XP/min
    const mins = curr.elapsedMs / 60000;
    rates.push({ x: mins, y: Math.max(0, rate) });
    peak = Math.max(peak, rate);
    peakRates.push({ x: mins, y: peak });
  }
  return { rates, peakRates };
}

function getActiveSkills(samples, targetSkill) {
  if (!samples || samples.length === 0) return [targetSkill];
  const firstSample = samples[0];
  const seen = new Set();
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (!s.skills) continue;
    for (const sk of SKILL_ORDER) {
      const startLvl = findSkillLevel(firstSample, sk);
      const currLvl = findSkillLevel(s, sk);
      if (currLvl > startLvl) seen.add(sk);
    }
  }
  seen.add(targetSkill);
  return SKILL_ORDER.filter(sk => seen.has(sk));
}

function makeSkillIcon(skill, size) {
  const img = new Image(size, size);
  img.src = VIEWS_BASE + 'skill-icons/' + skill + '.png';
  return img;
}

// Prepare trajectory steps for rendering
function prepareSteps(trajectory) {
  if (!trajectory || trajectory.length === 0) return [];
  const result = [];
  let toolBuffer = [];
  let toolTsBuffer = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    const groupTs = toolTsBuffer.find(t => t != null);
    result.push({
      type: 'tool-group',
      tools: toolBuffer.map(t => t.replace(/^mcp__rs-agent__/, '').replace(/^mcp__\w+__/, '')),
      ts: groupTs,
    });
    toolBuffer = [];
    toolTsBuffer = [];
  }

  for (const step of trajectory) {
    if (step.source === 'tool') {
      const label = step.text.replace(/^mcp__rs-agent__/, '').replace(/^mcp__\w+__/, '');
      if (step.detail) {
        flushTools();
        result.push({ type: 'tool-detail', label, detail: step.detail, ts: step.ts });
      } else {
        toolBuffer.push(step.text);
        toolTsBuffer.push(step.ts);
      }
    } else {
      flushTools();
      result.push({ type: 'agent', text: step.text, ts: step.ts });
    }
  }
  flushTools();
  return result;
}

// Sub-component for expandable tool details
function ToolDetail({ label, detail }) {
  const [open, setOpen] = useState(false);

  return html`
    <div className=${`traj-tool-detail${open ? ' open' : ''}`}>
      <div className="traj-tool-detail-header"
           onClick=${(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className="traj-tool-detail-toggle">\u25b6</span>
        <span>${label}</span>
      </div>
      ${open && html`<pre className="traj-tool-code">${detail}</pre>`}
    </div>
  `;
}

// Highlight the active step and optionally scroll to it
function highlightAndScrollToStep(container, currentStepTs, doScroll) {
  if (!container) return;
  const allSteps = container.querySelectorAll('[data-ts]');
  let activeEl = null;
  for (const el of allSteps) {
    el.classList.remove('active');
    const ts = parseFloat(el.dataset.ts);
    if (ts <= currentStepTs) activeEl = el;
  }
  if (activeEl) {
    activeEl.classList.add('active');
    if (doScroll) {
      const paneRect = container.getBoundingClientRect();
      const elRect = activeEl.getBoundingClientRect();
      const elCenter = elRect.top + elRect.height / 2;
      const paneCenter = paneRect.top + paneRect.height / 2;
      if (Math.abs(elCenter - paneCenter) > paneRect.height * 0.35) {
        activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
}

function getNavLists(data, model, skill) {
  // Models that have data for this skill (in config order)
  const modelsForSkill = Object.keys(MODEL_CONFIG)
    .filter(m => data?.[m]?.[skill])
    .sort((a, b) => (MODEL_CONFIG[a]?.order || 99) - (MODEL_CONFIG[b]?.order || 99));
  // Skills that have data for this model (in SKILL_ORDER)
  const skillsForModel = SKILL_ORDER.filter(s => data?.[model]?.[s]);
  return { modelsForSkill, skillsForModel };
}

export function TrajectoryModal({ model, skill, data }) {
  const trajData = data?.[model]?.[skill];
  const config = MODEL_CONFIG[model] || { displayName: model, color: '#999' };
  const skillName = SKILL_DISPLAY[skill] || skill;
  const videoSrc = trajData?.videoUrl || (trajData?.trialDir ? trajData.trialDir + '/verifier/recording.mp4' : null);
  const hasVideo = !!(trajData?.videoUrl || (trajData?.videoAvailable && trajData?.trialDir));
  const steps = useMemo(() => prepareSteps(trajData?.trajectory), [trajData]);

  const { modelsForSkill, skillsForModel } = useMemo(
    () => getNavLists(data, model, skill), [data, model, skill]
  );

  // Compute heatmap-style tier colors for nav buttons
  const { modelTiers, skillTiers } = useMemo(() => {
    if (!data) return { modelTiers: {}, skillTiers: {} };
    const allModels = Object.keys(data);

    // Model chips: tier each model's rate for the current skill
    const maxForSkill = Math.max(0, ...allModels.map(m => data[m]?.[skill]?.peakXpRate || 0));
    const modelTiers = {};
    for (const m of modelsForSkill) {
      const rate = data[m]?.[skill]?.peakXpRate || 0;
      modelTiers[m] = cellTier(rate, maxForSkill);
    }

    // Skill rail: tier current model's rate for each skill
    const skillTiers = {};
    for (const s of skillsForModel) {
      const maxForS = Math.max(0, ...allModels.map(m => data[m]?.[s]?.peakXpRate || 0));
      const rate = data[model]?.[s]?.peakXpRate || 0;
      skillTiers[s] = cellTier(rate, maxForS);
    }

    return { modelTiers, skillTiers };
  }, [data, model, skill, modelsForSkill, skillsForModel]);

  const [videoOffset, setVideoOffset] = useState(0);

  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const transcriptRef = useRef(null);
  const chartCanvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const rateChartCanvasRef = useRef(null);
  const rateChartInstanceRef = useRef(null);
  const videoOffsetRef = useRef(0);
  const maxVideoTimeRef = useRef(Infinity);
  const videoReadyRef = useRef(false);
  const chartDraggingRef = useRef(false);
  const initialRenderRef = useRef(true);

  // Scroll into view when user navigates (not on initial load)
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [model, skill]);

  // Seek video to a step timestamp
  const seekVideo = useCallback((stepTs) => {
    const videoEl = videoRef.current;
    if (!videoEl || !videoReadyRef.current) return;
    const targetTime = Math.min(stepTs + videoOffsetRef.current, maxVideoTimeRef.current);
    if (targetTime >= 0 && targetTime <= (videoEl.duration || Infinity)) {
      videoEl.currentTime = targetTime;
    }
    highlightAndScrollToStep(transcriptRef.current, stepTs, false);
  }, []);

  // Handle click on a transcript step
  const handleStepClick = useCallback((e) => {
    if (e.target.closest('.traj-tool-code')) return;
    if (e.target.closest('.traj-tool-detail-header')) return;
    const target = e.target.closest('[data-ts]');
    if (!target) return;
    const ts = parseFloat(target.dataset.ts);
    if (isNaN(ts)) return;
    seekVideo(ts);
  }, [seekVideo]);

  // Video setup
  useEffect(() => {
    if (!hasVideo || !videoRef.current) return;
    const videoEl = videoRef.current;

    function onMetadataReady() {
      videoReadyRef.current = true;
      videoEl.playbackRate = 2;
      let offset = 0;
      if (trajData.containerFinishedAt) {
        const finishedMs = new Date(trajData.containerFinishedAt).getTime();
        // Use ffprobe-measured duration (fragmented mp4 causes browsers to report wrong duration)
        const realDuration = trajData.videoDuration || videoEl.duration;
        const videoStartWallclock = finishedMs - (realDuration * 1000);
        // Use firstStepAt (when first trajectory step was recorded) for accurate sync,
        // fall back to agentStartedAt (when agent execution began, before first step)
        const syncTimestamp = trajData.firstStepAt || trajData.agentStartedAt;
        if (syncTimestamp) {
          const syncMs = new Date(syncTimestamp).getTime();
          offset = (syncMs - videoStartWallclock) / 1000;
        }
      }
      // If offset is negative, the video started after the agent — clamp to 0
      // so the video still plays (early tracking data just won't have video coverage)
      videoOffsetRef.current = Math.max(0, offset);
      // Clamp video to the game duration (don't show post-horizon recording)
      const gameDuration = trajData.durationSeconds || (30 * 60);
      const maxTime = videoOffsetRef.current + gameDuration;
      maxVideoTimeRef.current = maxTime > 0 ? maxTime : Infinity;
      setVideoOffset(offset);
    }

    // If metadata already loaded before effect ran, handle immediately
    if (videoEl.readyState >= 1) {
      onMetadataReady();
    }
    videoEl.onloadedmetadata = onMetadataReady;

    videoEl.onerror = () => {
      videoReadyRef.current = false;
    };

    videoEl.ontimeupdate = () => {
      // Clamp video to game duration (don't play past horizon)
      const maxTime = maxVideoTimeRef.current;
      if (isFinite(maxTime) && videoEl.currentTime > maxTime) {
        videoEl.pause();
        videoEl.currentTime = maxTime;
      }

      // Update chart playheads
      if (trajData?.samples?.length) {
        const agentTime = Math.max(0, videoEl.currentTime - videoOffsetRef.current);
        const gameMinutes = agentTime / 60;
        if (chartInstanceRef.current) {
          const xPixel = chartInstanceRef.current.scales.x.getPixelForValue(gameMinutes);
          chartInstanceRef.current._playheadX = xPixel;
          chartInstanceRef.current.draw();
        }
        if (rateChartInstanceRef.current) {
          const xPixel = rateChartInstanceRef.current.scales.x.getPixelForValue(gameMinutes);
          rateChartInstanceRef.current._playheadX = xPixel;
          rateChartInstanceRef.current.draw();
        }
      }

      // Auto-highlight current transcript step (no forced scroll)
      const currentStepTs = videoEl.currentTime - videoOffsetRef.current;
      highlightAndScrollToStep(transcriptRef.current, currentStepTs, false);
    };

    return () => {
      videoEl.pause();
      videoEl.ontimeupdate = null;
      videoEl.onloadedmetadata = null;
      videoEl.onerror = null;
    };
  }, [hasVideo, trajData]);

  // Skills chart setup
  useEffect(() => {
    const canvas = chartCanvasRef.current;
    if (!canvas || !trajData?.samples?.length) return;

    const samples = trajData.samples;
    const activeSkills = getActiveSkills(samples, skill);
    const lastElapsed = samples[samples.length - 1].elapsedMs || 1;
    const chartMaxMinutes = trajData.durationSeconds ? trajData.durationSeconds / 60 : lastElapsed / 60000;

    // Find data min/max for y-axis padding
    let yMin = Infinity, yMax = -Infinity;
    for (const s of samples) {
      for (const sk of activeSkills) {
        const lvl = findSkillLevel(s, sk);
        if (lvl < yMin) yMin = lvl;
        if (lvl > yMax) yMax = lvl;
      }
    }
    const yRange = Math.max(yMax - yMin, 1);
    const yPad = Math.max(yRange * 0.12, 2);

    const datasets = activeSkills.map(sk => {
      const color = SKILL_COLORS[sk] || '#888';
      const isTarget = sk === skill;
      return {
        label: SKILL_DISPLAY[sk] || sk,
        _skillKey: sk,
        data: samples.map(s => ({ x: s.elapsedMs / 60000, y: findSkillLevel(s, sk) })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: isTarget ? 2.5 : 1.2,
        pointRadius: 0,
        pointStyle: makeSkillIcon(sk, 14),
        tension: 0,
        order: isTarget ? 0 : 1,
      };
    });

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            type: 'linear', min: 0, max: chartMaxMinutes,
            title: { display: false },
            ticks: { display: false },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            min: Math.max(0, yMin - yPad),
            max: yMax + yPad,
            title: { display: false },
            afterFit: axis => { axis.width = 36; },
            ticks: {
              display: true,
              font: { size: 9 },
              color: '#aaa',
              maxTicksLimit: 5,
              callback: v => Number.isInteger(v) ? v : '',
            },
            grid: { color: 'rgba(0,0,0,0.04)' },
            border: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        layout: { padding: { top: 8, bottom: 10, left: 2, right: 24 } },
        interaction: { mode: 'nearest', intersect: false },
      },
      plugins: [{
        id: 'axisLines',
        afterDraw(chart) {
          const ctx = chart.ctx;
          const area = chart.chartArea;
          const yPx = chart.scales.y.getPixelForValue(yMin);
          const xPx = chart.scales.x.getPixelForValue(0);
          ctx.save();
          ctx.strokeStyle = 'rgba(0,0,0,0.12)';
          ctx.lineWidth = 1;
          // Horizontal line at data min
          ctx.beginPath();
          ctx.moveTo(area.left, yPx);
          ctx.lineTo(area.right, yPx);
          ctx.stroke();
          // Vertical line at x=0
          ctx.beginPath();
          ctx.moveTo(xPx, area.top);
          ctx.lineTo(xPx, area.bottom);
          ctx.stroke();
          ctx.restore();
        }
      }, {
        id: 'playhead',
        afterDraw(chart) {
          if (chart._playheadX == null) return;
          const ctx = chart.ctx;
          const area = chart.chartArea;
          const x = chart._playheadX;
          if (x < area.left || x > area.right) return;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }, {
        id: 'endIcons',
        _iconCache: {},
        _loadIcon(sk, cb) {
          const c = this._iconCache;
          if (c[sk]) { cb(c[sk]); return; }
          const img = new Image();
          img.onload = () => { c[sk] = img; cb(img); };
          img.onerror = () => cb(null);
          img.src = VIEWS_BASE + 'skill-icons/' + sk + '.png';
        },
        afterDraw(chart) {
          const ctx = chart.ctx;
          const area = chart.chartArea;
          const self = this;
          const size = 12;
          const icons = [];
          for (let i = 0; i < chart.data.datasets.length; i++) {
            const ds = chart.data.datasets[i];
            const meta = chart.getDatasetMeta(i);
            if (meta.hidden) continue;
            const pts = ds.data;
            if (!pts || pts.length === 0) continue;
            const lastPt = pts[pts.length - 1];
            const yPx = chart.scales.y.getPixelForValue(lastPt.y);
            icons.push({ skill: ds._skillKey, yPx });
          }
          // Resolve vertical overlaps
          icons.sort((a, b) => a.yPx - b.yPx);
          for (let j = 1; j < icons.length; j++) {
            if (icons[j].yPx - icons[j - 1].yPx < size + 1) {
              icons[j].yPx = icons[j - 1].yPx + size + 1;
            }
          }
          const xStart = area.right + 5;
          let needsRedraw = false;
          for (const ic of icons) {
            const y = Math.max(area.top, Math.min(area.bottom - size, ic.yPx - size / 2));
            const img = self._iconCache[ic.skill];
            if (img) {
              ctx.drawImage(img, xStart, y, size, size);
            } else {
              needsRedraw = true;
              self._loadIcon(ic.skill, () => {
                if (needsRedraw) { needsRedraw = false; chart.draw(); }
              });
            }
          }
        }
      }],
    });

    chartInstanceRef.current = chart;

    // Click + drag on chart scrubs video
    function seekChartToX(clientX) {
      if (!videoReadyRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const area = chart.chartArea;
      const xPx = clientX - rect.left;
      const ratio = (xPx - area.left) / (area.right - area.left);
      if (ratio < 0 || ratio > 1) return;
      const videoEl = videoRef.current;
      if (videoEl) {
        const xScale = chart.scales.x;
        const gameMinutes = xScale.min + ratio * (xScale.max - xScale.min);
        videoEl.currentTime = Math.max(0, gameMinutes * 60 + videoOffsetRef.current);
      }
    }

    const onMouseDown = (e) => { chartDraggingRef.current = true; seekChartToX(e.clientX); };
    const onMouseMove = (e) => { if (chartDraggingRef.current) seekChartToX(e.clientX); };
    const onMouseUp = () => { chartDraggingRef.current = false; };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      chart.destroy();
      chartInstanceRef.current = null;
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [trajData?.samples, skill]);

  // XP Rate chart setup
  useEffect(() => {
    const canvas = rateChartCanvasRef.current;
    if (!canvas || !trajData?.samples?.length) return;

    const { rates, peakRates } = computeRateData(trajData.samples, skill);
    if (rates.length === 0) return;

    const lastElapsed = trajData.samples[trajData.samples.length - 1].elapsedMs || 1;
    const rateChartMaxMinutes = trajData.durationSeconds ? trajData.durationSeconds / 60 : lastElapsed / 60000;
    // Rates are already real-game XP/min (normalized at computation time)
    const normRates = rates;
    const normPeakRates = peakRates;
    const maxRate = normPeakRates.length > 0 ? normPeakRates[normPeakRates.length - 1].y : 0;

    const datasets = [
      {
        label: 'XP Rate',
        data: normRates,
        borderColor: SKILL_COLORS[skill] || '#888',
        backgroundColor: (SKILL_COLORS[skill] || '#888') + '20',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0,
        fill: true,
        order: 1,
      },
      {
        label: 'Peak Rate',
        data: normPeakRates,
        borderColor: '#333',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0,
        fill: false,
        order: 0,
      },
    ];

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            type: 'linear', min: 0, max: rateChartMaxMinutes,
            title: { display: false },
            ticks: { display: false },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            min: 0,
            max: maxRate * 1.15,
            title: { display: false },
            afterFit: axis => { axis.width = 36; },
            ticks: {
              display: true,
              font: { size: 9 },
              color: '#aaa',
              callback: v => Math.round(v),
              maxTicksLimit: 4,
            },
            grid: { color: 'rgba(0,0,0,0.04)' },
            border: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        layout: { padding: { top: 2, bottom: 10, left: 2, right: 24 } },
      },
      plugins: [{
        id: 'ratePlayhead',
        afterDraw(chart) {
          if (chart._playheadX == null) return;
          const ctx = chart.ctx;
          const area = chart.chartArea;
          const x = chart._playheadX;
          if (x < area.left || x > area.right) return;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }],
    });

    rateChartInstanceRef.current = chart;

    // Click + drag on rate chart scrubs video
    function seekChartToX(clientX) {
      if (!videoReadyRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const area = chart.chartArea;
      const xPx = clientX - rect.left;
      const ratio = (xPx - area.left) / (area.right - area.left);
      if (ratio < 0 || ratio > 1) return;
      const videoEl = videoRef.current;
      if (videoEl) {
        const xScale = chart.scales.x;
        const gameMinutes = xScale.min + ratio * (xScale.max - xScale.min);
        videoEl.currentTime = Math.max(0, gameMinutes * 60 + videoOffsetRef.current);
      }
    }

    const onMouseDown = (e) => { chartDraggingRef.current = true; seekChartToX(e.clientX); };
    const onMouseMove = (e) => { if (chartDraggingRef.current) seekChartToX(e.clientX); };
    const onMouseUp = () => { chartDraggingRef.current = false; };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      chart.destroy();
      rateChartInstanceRef.current = null;
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [trajData?.samples, skill]);

  const horizonMin = trajData?.durationSeconds ? Math.round(trajData.durationSeconds / 60) : 30;
  const runDate = trajData?.containerFinishedAt || trajData?.agentStartedAt || trajData?.firstStepAt;
  const dateStr = runDate ? new Date(runDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  const skillRail = html`
    <aside className="traj-skill-rail" aria-label="Skill navigation">
      ${skillsForModel.map(s => {
        const tier = skillTiers[s] || TIERS.zero;
        return html`
          <button key=${s}
            type="button"
            className=${`traj-skill-rail-btn${s === skill ? ' active' : ''}`}
            style=${{ background: tier.bg }}
            title=${SKILL_DISPLAY[s] || s}
            onClick=${() => navigate('trajectory/' + model + '/' + s)}>
            <img src=${VIEWS_BASE + 'skill-icons/' + s + '.png'} alt=${SKILL_DISPLAY[s] || s} />
          </button>
        `;
      })}
    </aside>
  `;

  const navBar = html`
    <div className="traj-topbar">
      <div className="traj-nav-chips">
        ${modelsForSkill.map(m => {
          const mc = MODEL_CONFIG[m] || { shortName: m };
          const tier = modelTiers[m] || TIERS.zero;
          return html`
            <button key=${m}
              className=${`traj-chip model${m === model ? ' active' : ''}`}
              style=${{ background: tier.bg }}
              onClick=${() => navigate('trajectory/' + m + '/' + skill)}>
              ${mc.icon && html`<img src=${mc.icon} className="traj-chip-icon" />`}
              <span className="traj-chip-label">${mc.shortName || mc.displayName || m}</span>
            </button>
          `;
        })}
      </div>
    </div>
  `;

  const trajHeader = html`
    <section className="section" style=${{ paddingBottom: '0.75rem' }}>
      <div className="container is-max-widescreen has-text-centered">
        <h2 className="title is-3">Trajectories</h2>
      </div>
    </section>
  `;

  if (!trajData) {
    return html`
      <div ref=${containerRef}>
        ${trajHeader}
        <div className="traj-inline">
          ${navBar}
          <div className="traj-body">
            ${skillRail}
            <div style=${{ flex: 1, padding: '32px', textAlign: 'center', color: '#999' }}>
              No data available for this run.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return html`
    <div ref=${containerRef}>
      ${trajHeader}
      <div className="traj-inline">
        ${navBar}
        <div className="traj-body">
          ${skillRail}
          <div className="traj-video-container">
            ${hasVideo && html`
              <div className="traj-video-pane">
                <video ref=${videoRef} controls preload="auto"
                       src=${videoSrc} />
                <div className="traj-skills-chart-wrap">
                  <div className="traj-rate-legend">
                    <span className="traj-rate-legend-item">
                      <span className="traj-rate-legend-line" style=${{ borderColor: SKILL_COLORS[skill] || '#888', background: (SKILL_COLORS[skill] || '#888') + '20' }}></span>
                      XP Rate
                    </span>
                    <span className="traj-rate-legend-item">
                      <span className="traj-rate-legend-line dashed" style=${{ borderColor: '#333' }}></span>
                      Peak Rate
                    </span>
                  </div>
                  <canvas ref=${rateChartCanvasRef}></canvas>
                </div>
                <div className="traj-skills-chart-wrap">
                  <canvas ref=${chartCanvasRef}></canvas>
                </div>
              </div>
            `}
            <div className="traj-transcript-pane" ref=${transcriptRef} onClick=${handleStepClick}>
              <div className="traj-transcript-header">
                <img src=${VIEWS_BASE + 'skill-icons/' + skill + '.png'} className="traj-transcript-header-icon" />
                <span>${skillName} \u00b7 ${horizonMin}m \u00b7 ${config.shortName || config.displayName}</span>
                ${dateStr && html`<span className="traj-transcript-header-date">\u00b7 ${dateStr}</span>`}
              </div>
              ${steps.length === 0
                ? html`<div style=${{ color: '#999', textAlign: 'center', padding: '32px' }}>No trajectory data available for this run.</div>`
                : steps.map((step, i) => {
                    if (step.type === 'agent') {
                      return html`
                        <div key=${i} className="traj-step agent" data-ts=${step.ts != null ? String(step.ts) : undefined}>
                          ${step.ts != null && html`
                            <span className="traj-timestamp">${formatTimestamp(step.ts + videoOffset)}</span>
                          `}
                          ${step.text}
                        </div>
                      `;
                    }
                    if (step.type === 'tool-group') {
                      return html`
                        <div key=${i} className="traj-tool-group" data-ts=${step.ts != null ? String(step.ts) : undefined}>
                          ${step.tools.map((t, j) => html`
                            <span key=${j} className="traj-tool-chip">${t}</span>
                          `)}
                        </div>
                      `;
                    }
                    if (step.type === 'tool-detail') {
                      return html`
                        <div key=${i} data-ts=${step.ts != null ? String(step.ts) : undefined}>
                          <${ToolDetail} label=${step.label} detail=${step.detail} />
                        </div>
                      `;
                    }
                    return null;
                  })
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
