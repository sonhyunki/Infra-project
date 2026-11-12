const state = {
  status: 'idle',
  rateMode: 'rps',
  payloadMode: 'generated',
  history: [], // { rps, latencyMs }
  liveUpdateTimer: null,
};

const els = {
  form: document.getElementById('testForm'),
  method: document.getElementById('method'),
  targetUrl: document.getElementById('targetUrl'),
  fillEchoBtn: document.getElementById('fillEchoBtn'),

  rateBtns: document.querySelectorAll('[data-rate-mode]'),
  ratePanels: document.querySelectorAll('[data-rate-panel]'),
  rpsRange: document.getElementById('rpsRange'),
  targetRps: document.getElementById('targetRps'),
  concurrencyRange: document.getElementById('concurrencyRange'),
  concurrency: document.getElementById('concurrency'),
  mbpsRange: document.getElementById('mbpsRange'),
  targetMbps: document.getElementById('targetMbps'),

  payloadBtns: document.querySelectorAll('[data-payload-mode]'),
  payloadPanels: document.querySelectorAll('[data-payload-panel]'),
  payloadRange: document.getElementById('payloadRange'),
  payloadSizeValue: document.getElementById('payloadSizeValue'),
  payloadSizeUnit: document.getElementById('payloadSizeUnit'),
  customBody: document.getElementById('customBody'),
  getBodyNotice: document.getElementById('getBodyNotice'),

  stopCondition: document.getElementById('stopCondition'),
  stopValueWrap: document.getElementById('stopValueWrap'),
  stopValue: document.getElementById('stopValue'),
  stopUnit: document.getElementById('stopUnit'),

  headersInput: document.getElementById('headersInput'),
  timeoutMs: document.getElementById('timeoutMs'),
  maxConcurrency: document.getElementById('maxConcurrency'),
  keepAlive: document.getElementById('keepAlive'),
  insecureTls: document.getElementById('insecureTls'),

  liveSpeedHint: document.getElementById('liveSpeedHint'),
  livePayloadHint: document.getElementById('livePayloadHint'),
  errorBox: document.getElementById('errorBox'),
  toggleBtn: document.getElementById('toggleBtn'),

  statusBadge: document.getElementById('statusBadge'),
  elapsedText: document.getElementById('elapsedText'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),

  kpiRps: document.getElementById('kpiRps'),
  kpiActive: document.getElementById('kpiActive'),
  kpiMbps: document.getElementById('kpiMbps'),
  kpiBps: document.getElementById('kpiBps'),
  kpiCount: document.getElementById('kpiCount'),
  kpiSentBytes: document.getElementById('kpiSentBytes'),
  kpiLatency: document.getElementById('kpiLatency'),
  kpiPercentiles: document.getElementById('kpiPercentiles'),

  statusBuckets: document.getElementById('statusBuckets'),
  statusCodesList: document.getElementById('statusCodesList'),
  errorList: document.getElementById('errorList'),
  chart: document.getElementById('metricsChart'),
};

const UNIT_MULTIPLIER = { B: 1, KB: 1024, MB: 1024 * 1024 };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatDuration(ms) {
  const totalSec = Math.floor((ms || 0) / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function showError(message) {
  if (!message) {
    els.errorBox.textContent = '';
    els.errorBox.classList.add('hidden');
    return;
  }
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function parseHeadersText(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    if (key) headers[key] = val;
  }
  return headers;
}

function getPayloadSizeBytes() {
  const val = Math.max(0, Number(els.payloadSizeValue.value) || 0);
  const mult = UNIT_MULTIPLIER[els.payloadSizeUnit.value] ?? 1;
  return Math.round(val * mult);
}

function buildConfigFromForm() {
  const stopCond = els.stopCondition.value;
  const stopNum = Math.max(1, Number(els.stopValue.value) || 1);

  return {
    targetUrl: els.targetUrl.value.trim(),
    method: els.method.value,
    headers: parseHeadersText(els.headersInput.value),
    rateMode: state.rateMode,
    targetRps: Number(els.targetRps.value) || 10,
    concurrency: Number(els.concurrency.value) || 10,
    maxConcurrency: Number(els.maxConcurrency.value) || 200,
    targetMbps: Number(els.targetMbps.value) || 1,
    payloadMode: state.payloadMode,
    payloadSizeBytes: getPayloadSizeBytes(),
    customBody: els.customBody.value,
    stopCondition: stopCond,
    durationSec: stopCond === 'duration' ? stopNum : 30,
    totalRequests: stopCond === 'count' ? stopNum : 1000,
    totalBytesLimit: stopCond === 'bytes' ? stopNum * 1024 * 1024 : 10 * 1024 * 1024,
    timeoutMs: Number(els.timeoutMs.value) || 10000,
    keepAlive: els.keepAlive.checked,
    insecureTls: els.insecureTls.checked,
  };
}

function setRateMode(mode) {
  state.rateMode = mode;
  els.rateBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.rateMode === mode));
  els.ratePanels.forEach((p) => p.classList.toggle('hidden', p.dataset.ratePanel !== mode));
  scheduleLiveUpdate();
}

function setPayloadMode(mode) {
  state.payloadMode = mode;
  els.payloadBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.payloadMode === mode));
  els.payloadPanels.forEach((p) => p.classList.toggle('hidden', p.dataset.payloadPanel !== mode));
  updateGetBodyNotice();
  scheduleLiveUpdate();
}

function updateGetBodyNotice() {
  const isBodyless = els.method.value === 'GET' || els.method.value === 'HEAD';
  const hasPayload = state.payloadMode !== 'none' && (state.payloadMode === 'custom' || getPayloadSizeBytes() > 0);
  els.getBodyNotice.classList.toggle('hidden', !(isBodyless && hasPayload));
}

function updateStopConditionUI() {
  const val = els.stopCondition.value;
  els.stopValueWrap.classList.toggle('hidden', val === 'manual');
  if (val === 'duration') {
    els.stopUnit.textContent = '초';
    if (Number(els.stopValue.value) > 86400) els.stopValue.value = 30;
  } else if (val === 'count') {
    els.stopUnit.textContent = '회';
  } else if (val === 'bytes') {
    els.stopUnit.textContent = 'MB';
  }
}

function syncRangeAndNumber(rangeEl, numberEl) {
  rangeEl.addEventListener('input', () => {
    numberEl.value = rangeEl.value;
    scheduleLiveUpdate();
  });
  numberEl.addEventListener('input', () => {
    const num = Number(numberEl.value);
    if (Number.isFinite(num)) {
      rangeEl.value = String(Math.min(Number(rangeEl.max), Math.max(Number(rangeEl.min), num)));
    }
    scheduleLiveUpdate();
  });
}

function scheduleLiveUpdate() {
  if (state.status !== 'running') return;
  clearTimeout(state.liveUpdateTimer);
  state.liveUpdateTimer = setTimeout(async () => {
    if (state.status !== 'running') return;
    try {
      const cfg = buildConfigFromForm();
      const res = await fetch('/api/test/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rateMode: cfg.rateMode,
          targetRps: cfg.targetRps,
          concurrency: cfg.concurrency,
          targetMbps: cfg.targetMbps,
          payloadMode: cfg.payloadMode,
          payloadSizeBytes: cfg.payloadSizeBytes,
          customBody: cfg.customBody,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || '실시간 설정 반영 실패');
      } else {
        showError('');
      }
    } catch {
      // Ignore transient network errors during rapid dragging
    }
  }, 100);
}

function setRunningUI(isRunning) {
  const lockable = [
    els.method,
    els.targetUrl,
    els.fillEchoBtn,
    els.stopCondition,
    els.stopValue,
    els.headersInput,
    els.timeoutMs,
    els.maxConcurrency,
    els.keepAlive,
    els.insecureTls,
  ];
  lockable.forEach((el) => {
    el.disabled = isRunning;
  });

  els.liveSpeedHint.classList.toggle('hidden', !isRunning);
  els.livePayloadHint.classList.toggle('hidden', !isRunning);
  els.toggleBtn.textContent = isRunning ? '트래픽 전송 중지' : '트래픽 전송 시작';
  els.toggleBtn.classList.toggle('btn-danger', isRunning);
  els.toggleBtn.classList.toggle('btn-primary', !isRunning);
}

function renderSnapshot(snap) {
  if (!snap) return;
  const prevStatus = state.status;
  state.status = snap.status;

  const isRunning = snap.status === 'running';
  setRunningUI(isRunning);

  const badgeMap = {
    idle: ['대기 중', 'badge-idle'],
    running: ['실행 중', 'badge-running'],
    completed: ['완료됨', 'badge-completed'],
    stopped: ['중지됨', 'badge-stopped'],
  };
  const [label, cls] = badgeMap[snap.status] ?? ['대기 중', 'badge-idle'];
  els.statusBadge.textContent = label;
  els.statusBadge.className = `badge ${cls}`;
  els.elapsedText.textContent = formatDuration(snap.elapsedMs);

  if (snap.progress !== null && snap.progress !== undefined) {
    els.progressWrap.classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, snap.progress * 100));
    els.progressFill.style.width = `${pct.toFixed(1)}%`;
    els.progressLabel.textContent = `${pct.toFixed(0)}%`;
  } else {
    els.progressWrap.classList.add('hidden');
  }

  const m = snap.metrics;
  els.kpiRps.innerHTML = `${m.currentRps.toFixed(1)} <small>RPS</small>`;
  els.kpiActive.textContent = `활성 연결 ${m.activeConnections}개`;

  els.kpiMbps.innerHTML = `${m.currentSendMbps.toFixed(2)} <small>Mbps</small>`;
  els.kpiBps.textContent = `송신 ${formatBytes(m.currentSendBytesPerSec)}/s · 수신 ${formatBytes(m.currentRecvBytesPerSec)}/s`;

  els.kpiCount.textContent = `${m.successCount.toLocaleString()} / ${m.totalCompleted.toLocaleString()}`;
  els.kpiSentBytes.textContent = `실패 ${m.errorCount.toLocaleString()}건 · 누적 송신 ${formatBytes(m.bytesSent)}`;

  els.kpiLatency.innerHTML = `${m.latency.avgMs.toFixed(1)} <small>ms</small>`;
  els.kpiPercentiles.textContent = `P95 ${m.latency.p95Ms.toFixed(1)}ms · P99 ${m.latency.p99Ms.toFixed(1)}ms`;

  // Status buckets
  const b = m.statusBuckets;
  els.statusBuckets.innerHTML = '';
  for (const [key, clsName] of [
    ['2xx', 'pill-2xx'],
    ['3xx', 'pill-3xx'],
    ['4xx', 'pill-4xx'],
    ['5xx', 'pill-5xx'],
  ]) {
    const span = document.createElement('span');
    span.className = `pill ${clsName}`;
    span.textContent = `${key}: ${(b[key] || 0).toLocaleString()}`;
    els.statusBuckets.appendChild(span);
  }

  const codeEntries = Object.entries(m.statusCodes || {});
  els.statusCodesList.textContent =
    codeEntries.length > 0 ? codeEntries.map(([code, cnt]) => `${code}: ${cnt.toLocaleString()}건`).join('  ·  ') : '';

  // Errors
  els.errorList.innerHTML = '';
  if (!m.recentErrors || m.recentErrors.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '발생한 오류가 없습니다.';
    els.errorList.appendChild(li);
  } else {
    for (const item of m.recentErrors) {
      const li = document.createElement('li');
      const timeStr = new Date(item.time).toLocaleTimeString();
      li.textContent = `[${timeStr}] ${item.message}`;
      els.errorList.appendChild(li);
    }
  }

  if (isRunning || (prevStatus === 'running' && snap.status !== 'running')) {
    state.history.push({ rps: m.currentRps, latencyMs: m.latency.avgMs });
    if (state.history.length > 240) {
      state.history.shift();
    }
    drawChart();
  }
}

function drawChart() {
  const canvas = els.chart;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = 220;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 14, right: 44, bottom: 22, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Grid lines
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH * i) / 4;
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
  }
  ctx.stroke();

  const pts = state.history;
  if (pts.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('테스트를 시작하면 실시간 추이가 표시됩니다.', width / 2, height / 2);
    return;
  }

  const maxRps = Math.max(10, ...pts.map((p) => p.rps)) * 1.15;
  const maxLat = Math.max(10, ...pts.map((p) => p.latencyMs)) * 1.15;

  // Axis labels
  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(maxRps.toFixed(0), pad.left - 6, pad.top + 8);
  ctx.fillText('0', pad.left - 6, pad.top + plotH);

  ctx.textAlign = 'left';
  ctx.fillText(`${maxLat.toFixed(0)}ms`, width - pad.right + 6, pad.top + 8);
  ctx.fillText('0ms', width - pad.right + 6, pad.top + plotH);

  const drawSeries = (getter, maxVal, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = pad.left + (pts.length === 1 ? plotW : (idx / (pts.length - 1)) * plotW);
      const y = pad.top + plotH - Math.min(1, getter(p) / maxVal) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawSeries((p) => p.rps, maxRps, '#2563eb');
  drawSeries((p) => p.latencyMs, maxLat, '#16a34a');
}

async function startOrStop(e) {
  e.preventDefault();
  showError('');

  if (state.status === 'running') {
    const res = await fetch('/api/test/stop', { method: 'POST' });
    const data = await res.json();
    renderSnapshot(data);
    return;
  }

  const cfg = buildConfigFromForm();
  if (!cfg.targetUrl) {
    showError('대상 서버 URL을 입력해주세요.');
    els.targetUrl.focus();
    return;
  }

  state.history = [];
  drawChart();

  try {
    const res = await fetch('/api/test/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || '테스트 시작에 실패했습니다.');
      return;
    }
    renderSnapshot(data);
  } catch (err) {
    showError(err?.message || '서버와 통신할 수 없습니다.');
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('metrics', (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      renderSnapshot(snap);
    } catch {
      // ignore malformed packet
    }
  });
}

function init() {
  els.rateBtns.forEach((btn) =>
    btn.addEventListener('click', () => setRateMode(btn.dataset.rateMode))
  );
  els.payloadBtns.forEach((btn) =>
    btn.addEventListener('click', () => setPayloadMode(btn.dataset.payloadMode))
  );

  syncRangeAndNumber(els.rpsRange, els.targetRps);
  syncRangeAndNumber(els.concurrencyRange, els.concurrency);
  syncRangeAndNumber(els.mbpsRange, els.targetMbps);
  syncRangeAndNumber(els.payloadRange, els.payloadSizeValue);
  els.payloadRange.addEventListener('input', updateGetBodyNotice);
  els.payloadSizeValue.addEventListener('input', updateGetBodyNotice);

  els.payloadSizeUnit.addEventListener('change', () => {
    const unit = els.payloadSizeUnit.value;
    if (unit === 'B') {
      els.payloadRange.max = '4096';
    } else if (unit === 'KB') {
      els.payloadRange.max = '1024';
    } else {
      els.payloadRange.max = '50';
      if (Number(els.payloadSizeValue.value) > 50) {
        els.payloadSizeValue.value = '50';
      }
    }
    els.payloadRange.value = String(Math.min(Number(els.payloadRange.max), Number(els.payloadSizeValue.value) || 0));
    updateGetBodyNotice();
    scheduleLiveUpdate();
  });

  els.customBody.addEventListener('input', scheduleLiveUpdate);
  els.method.addEventListener('change', updateGetBodyNotice);
  els.stopCondition.addEventListener('change', updateStopConditionUI);

  els.fillEchoBtn.addEventListener('click', () => {
    els.targetUrl.value = `${window.location.origin}/echo`;
    if (els.method.value === 'GET') {
      els.method.value = 'POST';
      updateGetBodyNotice();
    }
  });

  els.form.addEventListener('submit', startOrStop);
  window.addEventListener('resize', drawChart);

  updateStopConditionUI();
  updateGetBodyNotice();
  drawChart();
  connectSSE();
}

init();
