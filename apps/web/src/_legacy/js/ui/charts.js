/**
 * Renders the sample "dashboard preview" widgets: a line chart and a
 * donut chart. All data here is illustrative — generated once on load
 * to look like a plausible balance history and allocation split.
 * Replace with real data once packages/services/balanceService.js exists.
 */
(function () {
  /* ---------- Line chart ---------- */
  const pathEl = document.getElementById('lineChartPath');
  const fillEl = document.getElementById('lineChartFill');
  const valueEl = document.getElementById('chartValue');
  const deltaEl = document.getElementById('chartDelta');

  const VIEW_W = 400;
  const VIEW_H = 140;
  const PAD = 8;

  function generateSeries(points) {
    let value = 1000;
    const series = [value];
    for (let i = 1; i < points; i++) {
      value = Math.max(200, value + (Math.random() - 0.4) * 55);
      series.push(value);
    }
    return series;
  }

  function buildPaths(series) {
    const max = Math.max(...series);
    const min = Math.min(...series);
    const range = max - min || 1;
    const stepX = (VIEW_W - PAD * 2) / (series.length - 1);

    const points = series.map((v, i) => [
      PAD + i * stepX,
      PAD + (1 - (v - min) / range) * (VIEW_H - PAD * 2),
    ]);

    const line = points.map((p, i) => (i === 0 ? `M ${p[0]},${p[1]}` : `L ${p[0]},${p[1]}`)).join(' ');
    const fill = line + ` L ${points[points.length - 1][0]},${VIEW_H - PAD} L ${points[0][0]},${VIEW_H - PAD} Z`;
    return { line, fill };
  }

  function animateLineIn() {
    if (!pathEl) return;
    const length = pathEl.getTotalLength();
    pathEl.style.strokeDasharray = String(length);
    pathEl.style.strokeDashoffset = String(length);
    pathEl.style.transition = 'stroke-dashoffset 1.5s cubic-bezier(0.16,1,0.3,1)';
    pathEl.getBoundingClientRect();
    pathEl.style.strokeDashoffset = '0';

    if (fillEl) {
      fillEl.style.opacity = '0';
      fillEl.style.transition = 'opacity 1s ease 0.35s';
      requestAnimationFrame(() => { fillEl.style.opacity = '1'; });
    }
  }

  function initLineChart() {
    if (!pathEl) return;
    const series = generateSeries(30);
    const { line, fill } = buildPaths(series);
    pathEl.setAttribute('d', line);
    if (fillEl) fillEl.setAttribute('d', fill);

    const first = series[0];
    const last = series[series.length - 1];
    const pct = (((last - first) / first) * 100).toFixed(1);
    if (valueEl) valueEl.textContent = '$' + last.toFixed(2);
    if (deltaEl) {
      const positive = last >= first;
      deltaEl.textContent = (positive ? '+' : '') + pct + '% (30d)';
      deltaEl.classList.toggle('up', positive);
    }
  }

  /* ---------- Donut chart ---------- */
  const RADIUS = 40;
  const CIRC = 2 * Math.PI * RADIUS;

  // [id, percentage] — mirrors the legend markup in index.html
  const donutSegments = [
    ['segSol', 62],
    ['segEth', 21],
    ['segBase', 11],
    ['segBtc', 6],
  ];

  function setupDonut() {
    let cumulative = 0;
    donutSegments.forEach(([id, pct]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const segLength = (pct / 100) * CIRC;
      el.setAttribute('stroke-dasharray', `${segLength} ${CIRC - segLength}`);
      el.setAttribute('stroke-dashoffset', String(CIRC)); // hidden initially
      el.dataset.targetOffset = String(-(cumulative / 100) * CIRC);
      cumulative += pct;
    });
  }

  function animateDonut() {
    donutSegments.forEach(([id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)';
      el.setAttribute('stroke-dashoffset', el.dataset.targetOffset);
    });
  }

  /* ---------- Bar-style progress fills (roadmap-style bars, if present) ---------- */
  function animateBars() {
    document.querySelectorAll('.bar-fill').forEach((bar) => bar.classList.add('filled'));
  }

  initLineChart();
  setupDonut();

  // Expose animate-in hooks so reveal.js can trigger them when the
  // relevant tile scrolls into view.
  window.FluxioCharts = { animateLineIn, animateDonut, animateBars };
})();
