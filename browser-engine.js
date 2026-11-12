const BODY_LESS_METHODS = new Set(['GET', 'HEAD']);
const LATENCY_WINDOW_SIZE = 2000;
const RECENT_ERRORS_LIMIT = 15;
const TICK_INTERVAL_MS = 250;

function computePercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function buildPayloadText(config) {
  if (BODY_LESS_METHODS.has(config.method) || config.payloadMode === 'none') {
    return '';
  }
  if (config.payloadMode === 'custom') {
    return config.customBody || '';
  }
  const size = Math.max(0, Number(config.payloadSizeBytes) || 0);
  if (size <= 0) return '';

  const contentType = Object.entries(config.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (contentType.toLowerCase().includes('application/json') && size >= 14) {
    const padLen = size - 14;
    return `{"payload":"${'x'.repeat(padLen)}"}`;
  }
  return 'x'.repeat(size);
}

/**
 * Browser-based HTTP/HTTPS load generator using fetch() for static hosting (e.g. GitHub Pages).
 */
export class BrowserTrafficEngine {
  constructor(onMetrics) {
    this.onMetrics = onMetrics;
    this.status = 'idle';
    this.config = null;
    this.payloadText = '';
    this.estimatedRequestBytes = 0;

    this.activeControllers = new Set();
    this.dispatchTimer = null;
    this.metricsTimer = null;
    this.durationTimer = null;

    this.startedAt = 0;
    this.endedAt = 0;
    this.lastTokenRefill = 0;
    this.tokens = 0;
    this.resetStats();
  }

  resetStats() {
    this.totalSent = 0;
    this.totalCompleted = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.statusBuckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
    this.statusCodes = {};
    this.recentErrors = [];

    this.latencySum = 0;
    this.latencyMin = Infinity;
    this.latencyMax = 0;
    this.latencyWindow = [];
    this.latencyCursor = 0;

    this.windowSamples = [];
    this.tickCompleted = 0;
    this.tickBytesSent = 0;
    this.tickBytesReceived = 0;
    this.tickErrors = 0;
  }

  start(rawConfig) {
    if (this.status === 'running') {
      throw new Error('이미 트래픽 테스트가 실행 중입니다.');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(String(rawConfig.targetUrl ?? '').trim());
    } catch {
      throw new Error('올바른 대상 서버 URL을 입력해주세요.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('http:// 또는 https:// 프로토콜만 지원합니다.');
    }
    if (window.location.protocol === 'https:' && parsedUrl.protocol === 'http:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
      throw new Error('HTTPS 페이지(GitHub Pages)에서는 보안상 HTTP 대상에 요청할 수 없습니다. HTTPS URL을 사용하거나 로컬 서버를 실행해주세요.');
    }

    this.config = { ...rawConfig, targetUrl: parsedUrl.toString() };
    this.rebuildPayload();
    this.resetStats();

    this.status = 'running';
    this.startedAt = performance.now();
    this.endedAt = 0;
    this.lastTokenRefill = this.startedAt;
    this.tokens = this.getInitialTokens();

    if (this.config.stopCondition === 'duration') {
      this.durationTimer = setTimeout(() => this.finish('completed'), (Number(this.config.durationSec) || 30) * 1000);
    }

    this.dispatchTimer = setInterval(() => this.pump(), 10);
    this.metricsTimer = setInterval(() => this.emitSnapshot(), TICK_INTERVAL_MS);

    this.pump();
    return this.emitSnapshot();
  }

  updateConfig(partial) {
    if (this.status !== 'running' || !this.config) return null;
    this.config = { ...this.config, ...partial };
    this.rebuildPayload();
    this.tokens = Math.min(this.tokens, this.getMaxBucketSize());
    this.pump();
    return this.emitSnapshot();
  }

  stop() {
    if (this.status !== 'running') return this.getSnapshot();
    this.finish('stopped');
    return this.getSnapshot();
  }

  rebuildPayload() {
    this.payloadText = buildPayloadText(this.config);
    const bodyBytes = new TextEncoder().encode(this.payloadText).length;
    this.estimatedRequestBytes = 120 + bodyBytes;
  }

  getRatePerSecond() {
    if (this.config.rateMode === 'rps') return Math.max(0.1, Number(this.config.targetRps) || 10);
    if (this.config.rateMode === 'bandwidth') return Math.max(0.01, Number(this.config.targetMbps) || 1) * 125_000;
    return Infinity;
  }

  getTokenCostPerRequest() {
    return this.config.rateMode === 'bandwidth' ? Math.max(64, this.estimatedRequestBytes) : 1;
  }

  getMaxBucketSize() {
    if (this.config.rateMode === 'rps') return Math.max(1, this.getRatePerSecond() * 0.2);
    if (this.config.rateMode === 'bandwidth') return Math.max(this.getTokenCostPerRequest(), this.getRatePerSecond() * 0.25);
    return Infinity;
  }

  getInitialTokens() {
    if (this.config.rateMode === 'rps') return Math.max(1, Math.min(this.getRatePerSecond() * 0.1, 10));
    if (this.config.rateMode === 'bandwidth') return this.getTokenCostPerRequest();
    return Infinity;
  }

  hasReachedStopLimit() {
    const { stopCondition, totalRequests, totalBytesLimit } = this.config;
    if (stopCondition === 'count' && this.totalSent >= totalRequests) return true;
    if (stopCondition === 'bytes' && this.bytesSent >= totalBytesLimit) return true;
    return false;
  }

  pump() {
    if (this.status !== 'running') return;
    if (this.hasReachedStopLimit()) {
      if (this.activeControllers.size === 0) this.finish('completed');
      return;
    }

    const now = performance.now();
    const maxConc =
      this.config.rateMode === 'concurrency'
        ? Math.max(1, Number(this.config.concurrency) || 10)
        : Math.max(1, Number(this.config.maxConcurrency) || 200);

    if (this.config.rateMode === 'concurrency') {
      while (this.status === 'running' && this.activeControllers.size < maxConc && !this.hasReachedStopLimit()) {
        this.dispatchOne();
      }
      return;
    }

    const elapsedSec = Math.max(0, (now - this.lastTokenRefill) / 1000);
    this.lastTokenRefill = now;
    this.tokens = Math.min(this.getMaxBucketSize(), this.tokens + elapsedSec * this.getRatePerSecond());

    const cost = this.getTokenCostPerRequest();
    let guard = 0;
    while (
      this.status === 'running' &&
      this.tokens >= cost &&
      this.activeControllers.size < maxConc &&
      !this.hasReachedStopLimit() &&
      guard < 250
    ) {
      this.tokens -= cost;
      this.dispatchOne();
      guard++;
    }
  }

  async dispatchOne() {
    const cfg = this.config;
    const reqBytes = this.estimatedRequestBytes;
    const body = this.payloadText;

    this.totalSent++;
    this.bytesSent += reqBytes;
    this.tickBytesSent += reqBytes;

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeoutMs = Math.max(100, Number(cfg.timeoutMs) || 10000);
    const timeoutId = setTimeout(() => controller.abort(new Error(`요청 타임아웃 (${timeoutMs}ms)`)), timeoutMs);
    const startTime = performance.now();

    try {
      const fetchOpts = {
        method: cfg.method,
        mode: cfg.noCors ? 'no-cors' : 'cors',
        cache: 'no-store',
        signal: controller.signal,
      };
      if (!cfg.noCors && cfg.headers && Object.keys(cfg.headers).length > 0) {
        fetchOpts.headers = cfg.headers;
      }
      if (body.length > 0 && !BODY_LESS_METHODS.has(cfg.method)) {
        fetchOpts.body = body;
      }

      const res = await fetch(cfg.targetUrl, fetchOpts);
      let respBytes = 0;
      if (res.type !== 'opaque') {
        const buf = await res.arrayBuffer();
        respBytes = buf.byteLength;
      }
      this.recordResult(performance.now() - startTime, res.type === 'opaque' ? 'opaque' : res.status, respBytes, null);
    } catch (err) {
      if (this.status !== 'running' && controller.signal.aborted) {
        return;
      }
      this.recordResult(performance.now() - startTime, 0, 0, err);
    } finally {
      clearTimeout(timeoutId);
      this.activeControllers.delete(controller);
      if (this.status === 'running') {
        if (this.hasReachedStopLimit() && this.activeControllers.size === 0) {
          this.finish('completed');
        } else if (this.config.rateMode === 'concurrency') {
          this.pump();
        }
      }
    }
  }

  recordResult(latencyMs, statusCode, respBytes, err) {
    this.totalCompleted++;
    this.tickCompleted++;
    this.bytesReceived += respBytes;
    this.tickBytesReceived += respBytes;

    this.latencySum += latencyMs;
    if (latencyMs < this.latencyMin) this.latencyMin = latencyMs;
    if (latencyMs > this.latencyMax) this.latencyMax = latencyMs;

    if (this.latencyWindow.length < LATENCY_WINDOW_SIZE) {
      this.latencyWindow.push(latencyMs);
    } else {
      this.latencyWindow[this.latencyCursor] = latencyMs;
      this.latencyCursor = (this.latencyCursor + 1) % LATENCY_WINDOW_SIZE;
    }

    if (err || statusCode === 0) {
      this.errorCount++;
      this.tickErrors++;
      const msg = err?.message || 'CORS 차단 또는 네트워크 연결 오류';
      this.recentErrors.unshift({ time: new Date().toISOString(), message: msg });
      if (this.recentErrors.length > RECENT_ERRORS_LIMIT) this.recentErrors.length = RECENT_ERRORS_LIMIT;
      return;
    }

    if (statusCode === 'opaque') {
      this.statusBuckets.other++;
      this.statusCodes.opaque = (this.statusCodes.opaque ?? 0) + 1;
      this.successCount++;
      return;
    }

    const codeKey = String(statusCode);
    this.statusCodes[codeKey] = (this.statusCodes[codeKey] ?? 0) + 1;

    if (statusCode >= 200 && statusCode < 300) {
      this.statusBuckets['2xx']++;
      this.successCount++;
    } else if (statusCode >= 300 && statusCode < 400) {
      this.statusBuckets['3xx']++;
      this.successCount++;
    } else if (statusCode >= 400 && statusCode < 500) {
      this.statusBuckets['4xx']++;
      this.errorCount++;
      this.tickErrors++;
    } else if (statusCode >= 500) {
      this.statusBuckets['5xx']++;
      this.errorCount++;
      this.tickErrors++;
    }
  }

  finish(finalStatus) {
    if (this.status !== 'running') return;
    this.status = finalStatus;
    this.endedAt = performance.now();

    clearInterval(this.dispatchTimer);
    clearInterval(this.metricsTimer);
    clearTimeout(this.durationTimer);
    this.dispatchTimer = null;
    this.metricsTimer = null;
    this.durationTimer = null;

    for (const c of this.activeControllers) {
      c.abort();
    }
    this.activeControllers.clear();
    this.emitSnapshot();
  }

  emitSnapshot() {
    this.windowSamples.push({
      completed: this.tickCompleted,
      bytesSent: this.tickBytesSent,
      bytesReceived: this.tickBytesReceived,
      errors: this.tickErrors,
      durationMs: TICK_INTERVAL_MS,
    });
    if (this.windowSamples.length > 4) this.windowSamples.shift();
    this.tickCompleted = 0;
    this.tickBytesSent = 0;
    this.tickBytesReceived = 0;
    this.tickErrors = 0;

    const snap = this.getSnapshot();
    if (this.onMetrics) this.onMetrics(snap);
    return snap;
  }

  getSnapshot() {
    const now = this.status === 'running' ? performance.now() : (this.endedAt || performance.now());
    const elapsedMs = this.startedAt > 0 ? Math.max(0, now - this.startedAt) : 0;
    const windowSec = this.windowSamples.reduce((acc, s) => acc + s.durationMs, 0) / 1000;
    const windowCompleted = this.windowSamples.reduce((acc, s) => acc + s.completed, 0);
    const windowBytesSent = this.windowSamples.reduce((acc, s) => acc + s.bytesSent, 0);
    const windowBytesReceived = this.windowSamples.reduce((acc, s) => acc + s.bytesReceived, 0);

    const currentRps = windowSec > 0 ? windowCompleted / windowSec : 0;
    const currentSendBps = windowSec > 0 ? windowBytesSent / windowSec : 0;
    const currentRecvBps = windowSec > 0 ? windowBytesReceived / windowSec : 0;

    const sorted = [...this.latencyWindow].sort((a, b) => a - b);
    let progress = null;
    if (this.config) {
      if (this.config.stopCondition === 'duration') {
        progress = Math.min(1, elapsedMs / (this.config.durationSec * 1000));
      } else if (this.config.stopCondition === 'count') {
        progress = Math.min(1, this.totalSent / this.config.totalRequests);
      } else if (this.config.stopCondition === 'bytes') {
        progress = Math.min(1, this.bytesSent / this.config.totalBytesLimit);
      }
    }

    return {
      status: this.status,
      elapsedMs,
      progress,
      config: this.config,
      metrics: {
        activeConnections: this.activeControllers.size,
        totalSent: this.totalSent,
        totalCompleted: this.totalCompleted,
        successCount: this.successCount,
        errorCount: this.errorCount,
        bytesSent: this.bytesSent,
        bytesReceived: this.bytesReceived,
        currentRps,
        currentSendBytesPerSec: currentSendBps,
        currentRecvBytesPerSec: currentRecvBps,
        currentSendMbps: (currentSendBps * 8) / 1_000_000,
        latency: {
          avgMs: this.totalCompleted > 0 ? this.latencySum / this.totalCompleted : 0,
          minMs: this.latencyMin === Infinity ? 0 : this.latencyMin,
          maxMs: this.latencyMax,
          p50Ms: computePercentile(sorted, 50),
          p95Ms: computePercentile(sorted, 95),
          p99Ms: computePercentile(sorted, 99),
        },
        statusBuckets: { ...this.statusBuckets },
        statusCodes: { ...this.statusCodes },
        recentErrors: [...this.recentErrors],
      },
    };
  }
}
