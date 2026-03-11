// Standalone cumulative peak rate chart renderer for RuneBench
// Requires: Chart.js, shared-constants.js

(function() {
  // Icon caches
  const modelIconImages = {};
  const skillIconImages = {};

  // Skill line colors for single-model view
  const SKILL_LINE_COLORS = {};
  const _palette = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6','#bcbd22','#17becf','#469990','#e377c2','#9A6324','#800000','#aaffc3','#808000','#000075'];
  SKILL_ORDER.forEach(function(skill, i) { SKILL_LINE_COLORS[skill] = _palette[i]; });

  function preloadIcons(onReady) {
    let remaining = 0;

    for (const [key, config] of Object.entries(MODEL_CONFIG)) {
      if (config.icon) {
        remaining++;
        const img = new Image();
        img.onload = img.onerror = () => { if (--remaining === 0 && onReady) onReady(); };
        img.src = config.icon;
        modelIconImages[key] = img;
      }
    }

    for (const skill of SKILL_ORDER) {
      remaining++;
      const img = new Image();
      img.onload = img.onerror = () => { if (--remaining === 0 && onReady) onReady(); };
      img.src = VIEWS_BASE + 'skill-icons/' + skill + '.png';
      skillIconImages[skill] = img;
    }

    if (remaining === 0 && onReady) onReady();
  }

  // Chart.js plugin: draw model icon + label at end of each line, with hover support
  const endIconPlugin = {
    id: 'endIconCumulative',
    afterDraw(chart) {
      const ctx = chart.ctx;
      const size = 14;
      const labelGap = 3;
      const minSpacing = 12;

      const labels = [];
      for (const dataset of chart.data.datasets) {
        if (!dataset._modelKey && !dataset._skillKey) continue;
        const meta = chart.getDatasetMeta(chart.data.datasets.indexOf(dataset));
        if (!meta.visible) continue;
        const elements = meta.data;
        if (elements.length === 0) continue;
        const last = elements[elements.length - 1];
        if (!last) continue;

        if (dataset._skillKey) {
          const skill = dataset._skillKey;
          labels.push({
            x: last.x, y: last.y, drawY: last.y,
            iconImg: skillIconImages[skill],
            name: SKILL_DISPLAY[skill] || skill,
            color: SKILL_LINE_COLORS[skill] || '#999',
          });
        } else {
          const config = MODEL_CONFIG[dataset._modelKey] || { shortName: dataset._modelKey, color: '#999' };
          labels.push({
            x: last.x, y: last.y, drawY: last.y,
            iconImg: modelIconImages[dataset._modelKey],
            name: config.shortName || config.displayName,
            color: config.color,
          });
        }
      }

      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) {
        const gap = labels[i].drawY - labels[i - 1].drawY;
        if (gap < minSpacing) labels[i].drawY = labels[i - 1].drawY + minSpacing;
      }

      for (const label of labels) {
        const icon = label.iconImg;
        ctx.save();
        ctx.globalAlpha = 0.9;
        if (icon && icon.complete) {
          ctx.drawImage(icon, label.x - size / 2, label.y - size / 2, size, size);
        }
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = label.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(label.name, label.x + size / 2 + labelGap, label.drawY);
        ctx.restore();
      }
    }
  };

  // Custom HTML tooltip
  let tooltipEl = null;
  function getTooltipEl() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'chart-tooltip';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function makeTooltipHandler(cumulativeSkillPeakRate, activeSkill, selectedModel) {
    return function(context) {
      const { chart, tooltip } = context;
      const el = getTooltipEl();

      if (tooltip.opacity === 0) { el.style.opacity = '0'; return; }

      const item = tooltip.dataPoints?.[0];
      if (!item) return;

      const ds = item.dataset;
      const minute = Math.floor(item.parsed.x * 10) / 10;
      const rateValue = item.parsed.y;
      let html;

      if (ds._skillKey) {
        const skillName = SKILL_DISPLAY[ds._skillKey] || ds._skillKey;
        const iconSrc = VIEWS_BASE + 'skill-icons/' + ds._skillKey + '.png';
        html = `<div class="chart-tooltip-title"><img src="${iconSrc}">${skillName} — ${minute} min</div>`;
        html += `<div class="chart-tooltip-avg">${formatRate(rateValue)}</div>`;
      } else {
        const modelKey = ds._modelKey;
        const config = MODEL_CONFIG[modelKey] || { displayName: modelKey, color: '#999' };
        html = `<div class="chart-tooltip-title">`;
        if (config.icon) html += `<img src="${config.icon}">`;
        html += `${config.displayName} — ${minute} min</div>`;

        if (activeSkill) {
          const skillName = SKILL_DISPLAY[activeSkill] || activeSkill;
          const iconSrc = VIEWS_BASE + 'skill-icons/' + activeSkill + '.png';
          html += `<div class="chart-tooltip-avg">${skillName}: ${formatRate(rateValue)}</div>`;
          html += `<div class="chart-tooltip-skill">`;
          html += `<img src="${iconSrc}">`;
          html += `<span>${skillName}</span>`;
          html += `<span class="xp">${formatRate(rateValue)}</span>`;
          html += `</div>`;
        } else {
          html += `<div class="chart-tooltip-avg">\u27e8ln\u27e9: ${rateValue.toFixed(1)}</div>`;

          const skills = cumulativeSkillPeakRate[modelKey] || [];
          for (const s of skills) {
            const iconSrc = VIEWS_BASE + 'skill-icons/' + s.skill + '.png';
            const zeroClass = s.peakRate === 0 ? ' zero' : '';
            html += `<div class="chart-tooltip-skill">`;
            html += `<img src="${iconSrc}">`;
            html += `<span>${s.label}</span>`;
            html += `<span class="xp${zeroClass}">${formatRate(s.peakRate)}</span>`;
            html += `</div>`;
          }
        }
      }

      el.innerHTML = html;
      el.style.opacity = '1';

      const rect = chart.canvas.getBoundingClientRect();
      const caretX = rect.left + window.scrollX + tooltip.caretX;
      const caretY = rect.top + window.scrollY + tooltip.caretY;

      const tipWidth = el.offsetWidth || 240;
      if (caretX + tipWidth + 16 > window.innerWidth + window.scrollX) {
        el.style.left = (caretX - tipWidth - 12) + 'px';
      } else {
        el.style.left = (caretX + 12) + 'px';
      }
      el.style.top = (caretY - 20) + 'px';
    };
  }

  /**
   * Render a cumulative peak XP rate chart.
   * @param {Object} opts
   * @param {HTMLElement} opts.canvasContainer - element to hold the <canvas>
   * @param {HTMLElement} opts.legendContainer - element to hold the legend
   * @param {Object} opts.data - combined data (model -> skill -> {samples, peakXpRate, ...})
   * @param {number} opts.horizonMinutes - e.g. 30
   * @param {string|null} [opts.activeSkill] - selected skill key, or null for total
   */
  window.renderCumulativeChart = function({ canvasContainer, legendContainer, labelContainer, data, horizonMinutes, activeSkill = null, onClick, selectedModel = null, onLegendClick = null }) {
    const cumulativeSkillPeakRate = {};
    const hiddenModels = new Set();
    let chart = null;
    let hoveredModel = null;

    function getModels() {
      return Object.keys(data)
        .sort((a, b) => ((MODEL_CONFIG[a] || {order:99}).order) - ((MODEL_CONFIG[b] || {order:99}).order));
    }

    function getModelTotalRate(model) {
      const skills = data[model];
      if (!skills) return 0;
      const rates = Object.values(skills).map(s => s.peakXpRate || 0);
      if (rates.length === 0) return 0;
      const logSum = rates.reduce((sum, r) => sum + Math.log(1 + r), 0);
      return logSum / rates.length;
    }

    function getModelSkillRate(model, skill) {
      return data[model]?.[skill]?.peakXpRate || 0;
    }

    function getLegendRate(model) {
      return activeSkill ? getModelSkillRate(model, activeSkill) : getModelTotalRate(model);
    }

    function getModelsByPerformance() {
      return Object.keys(data).sort((a, b) => getLegendRate(b) - getLegendRate(a));
    }

    function renderLegend() {
      const models = getModels();
      legendContainer.innerHTML = models.map(name => {
        const config = MODEL_CONFIG[name] || { displayName: name, shortName: name, color: '#999' };
        const iconSrc = config.icon || '';
        const isActive = selectedModel === name;
        const activeStyle = isActive ? 'background:#eaf2ff;border-radius:6px;box-shadow:inset 0 0 0 2px #4f8df7;padding:3px 8px' : '';
        return `<div class="legend-item" data-model="${name}" style="${activeStyle}">
          ${iconSrc ? `<img src="${iconSrc}" style="width:14px;height:14px" />` : ''}
          <span class="legend-label" style="border-bottom:2px solid ${config.color};padding-bottom:1px">${config.shortName || config.displayName}</span>
        </div>`;
      }).join('');

      legendContainer.querySelectorAll('.legend-item').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          const model = el.dataset.model;
          if (onLegendClick) {
            onLegendClick(selectedModel === model ? null : model);
          } else {
            if (hiddenModels.has(model)) hiddenModels.delete(model);
            else hiddenModels.add(model);
            renderLegend();
            renderChart();
          }
        });
        el.addEventListener('mouseenter', () => {
          const model = el.dataset.model;
          if (model === selectedModel) return;
          hoveredModel = model;
          renderChart();
          if (labelContainer) {
            const cfg = MODEL_CONFIG[hoveredModel] || { displayName: hoveredModel };
            labelContainer.textContent = cfg.displayName + ' \u2014 Per-Skill Peak Rate';
          }
        });
        el.addEventListener('mouseleave', () => {
          if (!hoveredModel) return;
          hoveredModel = null;
          renderChart();
          if (labelContainer) {
            if (selectedModel) {
              const cfg = MODEL_CONFIG[selectedModel] || { displayName: selectedModel };
              labelContainer.textContent = cfg.displayName + ' \u2014 Per-Skill Peak Rate';
            } else {
              labelContainer.textContent = activeSkill
                ? (SKILL_DISPLAY[activeSkill] || activeSkill) + ' Peak Rate'
                : 'Average';
            }
          }
        });
      });
    }

    function renderChart() {
      if (chart) { chart.destroy(); chart = null; }
      canvasContainer.innerHTML = '';

      const canvas = document.createElement('canvas');
      canvasContainer.appendChild(canvas);

      const datasets = [];
      const effectiveModel = hoveredModel || selectedModel;

      if (effectiveModel) {
        for (const skill of SKILL_ORDER) {
          if (hiddenModels.has(skill)) continue;
          const skillData = data[effectiveModel]?.[skill];
          if (!skillData || !skillData.peakXpRate) continue;
          let ratePoints = extractPeakRatePoints(skillData, skill, horizonMinutes);
          if (ratePoints.length === 0) continue;
          if (ratePoints[0].x > 0) ratePoints = [{ x: 0, y: 0 }, ...ratePoints];
          const color = SKILL_LINE_COLORS[skill] || '#999';
          datasets.push({
            label: SKILL_DISPLAY[skill] || skill,
            data: ratePoints,
            borderColor: color,
            backgroundColor: color,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2.5,
            tension: 0,
            _skillKey: skill,
          });
        }
      } else {
        const models = getModels().filter(m => !hiddenModels.has(m));
        for (const model of models) {
          const config = MODEL_CONFIG[model] || { displayName: model, color: '#999' };
          let ratePoints = [];

          if (activeSkill) {
            ratePoints = extractPeakRatePoints(data[model]?.[activeSkill], activeSkill, horizonMinutes);
          } else {
            const BUCKET_COUNT = horizonMinutes + 1;
            const bucketLogSums = new Array(BUCKET_COUNT).fill(0);
            const bucketCounts = new Array(BUCKET_COUNT).fill(0);

            for (const skill of SKILL_ORDER) {
              const points = extractPeakRatePoints(data[model]?.[skill], skill, horizonMinutes);
              if (points.length === 0) continue;

              for (let min = 0; min < BUCKET_COUNT; min++) {
                let lastRate = 0;
                for (const p of points) {
                  if (p.x <= min) lastRate = p.y;
                  else break;
                }
                bucketLogSums[min] += Math.log(1 + lastRate);
                bucketCounts[min]++;
              }
            }

            const skillRates = [];
            for (const skill of SKILL_ORDER) {
              const sd = data[model]?.[skill];
              if (sd) skillRates.push({ skill, label: SKILL_DISPLAY[skill] || skill, peakRate: sd.peakXpRate || 0 });
            }
            skillRates.sort((a, b) => b.peakRate - a.peakRate);
            cumulativeSkillPeakRate[model] = skillRates;

            for (let min = 0; min < BUCKET_COUNT; min++) {
              if (bucketCounts[min] > 0) {
                ratePoints.push({ x: min, y: +(bucketLogSums[min] / bucketCounts[min]).toFixed(2) });
              }
            }
          }

          datasets.push({
            label: config.displayName,
            data: ratePoints,
            borderColor: config.color,
            backgroundColor: config.color,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2.5,
            tension: 0,
            _modelKey: model,
          });
        }
      }

      const tooltipHandler = makeTooltipHandler(cumulativeSkillPeakRate, activeSkill, effectiveModel);

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        plugins: [endIconPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          layout: { padding: { top: 10, right: 96, bottom: 2 } },
          interaction: { mode: 'nearest', intersect: false },
          onClick: onClick ? function(event, elements) {
            if (elements.length > 0) {
              var ds = datasets[elements[0].datasetIndex];
              if (ds._skillKey) onClick(ds._skillKey);
              else if (ds._modelKey) onClick(ds._modelKey);
            }
          } : undefined,
          scales: {
            x: {
              type: 'linear',
              min: 0,
              max: horizonMinutes,
              ticks: { color: '#999', font: { size: 11 }, stepSize: horizonMinutes <= 10 ? 2 : 5, callback: v => v + ' min' },
              grid: { color: '#f0f0f0', drawTicks: false },
              border: { color: '#e0e0e0' },
              title: { display: true, text: 'Elapsed Time', color: '#999', font: { size: 12 } },
            },
            y: {
              type: 'linear',
              min: 0,
              ticks: {
                color: '#999',
                font: { size: 11, family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace' },
                maxTicksLimit: 8,
                callback: v => (activeSkill || effectiveModel) ? (v >= 1000 ? (v / 1000).toFixed(0) + 'k/min' : Math.round(v) + '/min') : v,
              },
              grid: { color: '#f0f0f0', drawTicks: false },
              border: { color: '#e0e0e0' },
              title: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: tooltipHandler,
            },
          },
        },
      });

    }

    preloadIcons(() => { if (chart) chart.draw(); });
    renderChart();
    renderLegend();
  };
})();
