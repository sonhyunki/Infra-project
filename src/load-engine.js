import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ALLOWED_RATE_MODES = new Set(['rps', 'concurrency', 'bandwidth']);
const ALLOWED_PAYLOAD_MODES = new Set(['none', 'generated', 'custom']);
const ALLOWED_STOP_CONDITIONS = new Set(['duration', 'count', 'bytes', 'manual']);
const BODY_LESS_METHODS = new Set(['GET', 'HEAD']);

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB safety cap per request
const MAX_CONCURRENCY = 2000;
const LATENCY_WINDOW_SIZE = 2000;
const RECENT_ERRORS_LIMIT = 15;
const TICK_INTERVAL_MS = 250;

/**
 * Validates and normalizes user-supplied load test configuration.
 */
export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('설정 객체가 올바르지 않습니다.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(String(raw.targetUrl ?? '').trim());
  } catch {
    throw new Error('올바른 대상 서버 URL을 입력해주세요. (예: http://localhost:8080/api)');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('http:// 또는 https:// 프로토콜만 지원합니다.');
  }

  const method = String(raw.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`지원하지 않는 HTTP 메서드입니다: ${method}`);
  }

  const rateMode = String(raw.rateMode ?? 'rps');
  if (!ALLOWED_RATE_MODES.has(rateMode)) {
    throw new Error(`지원하지 않는 속도 모드입니다: ${rateMode}`);
  }

  const payloadMode = String(raw.payloadMode ?? 'none');
  if (!ALLOWED_PAYLOAD_MODES.has(payloadMode)) {
    throw new Error(`지원하지 않는 페이로드 모드입니다: ${payloadMode}`);
  }

  const stopCondition = String(raw.stopCondition ?? 'duration');
  if (!ALLOWED_STOP_CONDITIONS.has(stopCondition)) {
    throw new Error(`지원하지 않는 종료 조건입니다: ${stopCondition}`);
  }

  const headers = normalizeHeaders(raw.headers);

  const targetRps = clampNumber(raw.targetRps, 0.1, 20000, 10);
  const concurrency = Math.round(clampNumber(raw.concurrency, 1, MAX_CONCURRENCY, 10));
  const maxConcurrency = Math.round(clampNumber(raw.maxConcurrency, 1, MAX_CONCURRENCY, 200));
  const targetMbps = clampNumber(raw.targetMbps, 0.01, 2000, 1);

  const payloadSizeBytes = Math.round(clampNumber(raw.payloadSizeBytes, 0, MAX_PAYLOAD_BYTES, 0));
  const customBody = typeof raw.customBody === 'string' ? raw.customBody : '';

  const durationSec = clampNumber(raw.durationSec, 1, 86400, 30);
  const totalRequests = Math.round(clampNumber(raw.totalRequests, 1, 100_000_000, 1000));
  const totalBytesLimit = Math.round(clampNumber(raw.totalBytesLimit, 1, 100 * 1024 * 1024 * 1024, 10 * 1024 * 1024));
  const timeoutMs = Math.round(clampNumber(raw.timeoutMs, 100, 120000, 10000));

  return {
    targetUrl: parsedUrl.toString(),
    parsedUrl,
    method,
    headers,
    rateMode,
    targetRps,
    concurrency,
    maxConcurrency,
    targetMbps,
    payloadMode,
    payloadSizeBytes,
    customBody,
    stopCondition,
    durationSec,
    totalRequests,
    totalBytesLimit,
    timeoutMs,
    keepAlive: raw.keepAlive !== false,
    insecureTls: Boolean(raw.insecureTls),
  };
}

function normalizeHeaders(rawHeaders) {
  const result = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return result;
  }
  for (const [key, value] of Object.entries(rawHeaders)) {
    const k = String(key).trim();
    if (!k) continue;
    result[k] = String(value ?? '');
  }
  return result;
}

function clampNumber(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function buildPayloadBuffer(config) {
  if (BODY_LESS_METHODS.has(config.method) || config.payloadMode === 'none') {
    return Buffer.alloc(0);
  }
  if (config.payloadMode === 'custom') {
    return Buffer.from(config.customBody, 'utf8');
  }
  const size = config.payloadSizeBytes;
  if (size <= 0) return Buffer.alloc(0);

  const contentType = Object.entries(config.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (contentType.toLowerCase().includes('application/json') && size >= 14) {
    const prefix = '{"payload":"';
    const suffix = '"}';
    const buf = Buffer.allocUnsafe(size);
    buf.write(prefix, 0, 'utf8');
    buf.fill(0x78, prefix.length, size - suffix.length); // 'x'
    buf.write(suffix, size - suffix.length, 'utf8');
    return buf;
  }

  return Buffer.alloc(size, 0x78);
}

function estimateHeaderBytes(config, bodyLength) {
  let bytes = config.method.length + config.parsedUrl.pathname.length + config.parsedUrl.search.length + 12;
  bytes += config.parsedUrl.host.length + 8;
  for (const [k, v] of Object.entries(config.headers)) {
    bytes += k.length + v.length + 4;
  }
  if (bodyLength > 0) {
    bytes += String(bodyLength).length + 20;
  }
  return bytes;
}

function computePercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Configurable HTTP/HTTPS load generator supporting live rate/payload updates
 * and real-time sliding-window telemetry.
 */
export class TrafficEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // 'idle' | 'running' | 'stopped' | 'completed'
    this.config = null;
    this.payloadBuffer = Buffer.alloc(0);
    this.estimatedRequestBytes = 0;

    this.agent = null;
    this.activeRequests = new Set();
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

    // 4 x 250ms buckets = 1s rolling window for live rate calculation
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

    this.config = normalizeConfig(rawConfig);
    this.rebuildPayloadAndHeaders();
    this.resetStats();

    const isHttps = this.config.parsedUrl.protocol === 'https:';
    const AgentClass = isHttps ? https.Agent : http.Agent;
    this.agent = new AgentClass({
      keepAlive: this.config.keepAlive,
      maxSockets: Math.max(this.config.concurrency, this.config.maxConcurrency, 64),
      ...(isHttps ? { rejectUnauthorized: !this.config.insecureTls } : {}),
    });

    this.status = 'running';
    this.startedAt = performance.now();
    this.endedAt = 0;
    this.lastTokenRefill = this.startedAt;
    this.tokens = this.getInitialTokens();

    if (this.config.stopCondition === 'duration') {
      this.durationTimer = setTimeout(() => {
        this.finish('completed');
      }, this.config.durationSec * 1000);
    }

    this.dispatchTimer = setInterval(() => this.pump(), 10);
    this.metricsTimer = setInterval(() => this.emitSnapshot(), TICK_INTERVAL_MS);

    this.pump();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  /**
   * Updates rate or payload parameters dynamically without interrupting the running test.
   */
  updateConfig(partial = {}) {
    if (this.status !== 'running' || !this.config) {
      throw new Error('실행 중인 테스트가 없습니다.');
    }

    const merged = {
      ...this.config,
      ...partial,
      targetUrl: this.config.targetUrl,
      method: this.config.method,
    };
    const next = normalizeConfig(merged);
    this.config = next;
    this.rebuildPayloadAndHeaders();
    this.tokens = Math.min(this.tokens, this.getMaxBucketSize());
    this.pump();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  stop() {
    if (this.status !== 'running') {
      return this.getSnapshot();
    }
    this.finish('stopped');
    return this.getSnapshot();
  }

  rebuildPayloadAndHeaders() {
    this.payloadBuffer = buildPayloadBuffer(this.config);
    this.estimatedRequestBytes = estimateHeaderBytes(this.config, this.payloadBuffer.length) + this.payloadBuffer.length;
  }

  getRatePerSecond() {
    if (!this.config) return 0;
    if (this.config.rateMode === 'rps') return this.config.targetRps;
    if (this.config.rateMode === 'bandwidth') {
      // 1 Mbps = 1,000,000 bits/s = 125,000 bytes/s
      return this.config.targetMbps * 125_000;
    }
    return Infinity;
  }

  getTokenCostPerRequest() {
    if (this.config.rateMode === 'bandwidth') {
      return Math.max(64, this.estimatedRequestBytes);
    }
    return 1;
  }

  getMaxBucketSize() {
    if (this.config.rateMode === 'rps') {
      return Math.max(1, this.config.targetRps * 0.2);
    }
    if (this.config.rateMode === 'bandwidth') {
      const bps = this.getRatePerSecond();
      return Math.max(this.getTokenCostPerRequest(), bps * 0.25);
    }
    return Infinity;
  }

  getInitialTokens() {
    if (this.config.rateMode === 'rps') {
      return Math.max(1, Math.min(this.config.targetRps * 0.1, 10));
    }
    if (this.config.rateMode === 'bandwidth') {
      return this.getTokenCostPerRequest();
    }
    return Infinity;
  }

  hasReachedStopLimit() {
    if (!this.config) return true;
    const { stopCondition, totalRequests, totalBytesLimit } = this.config;
    if (stopCondition === 'count' && this.totalSent >= totalRequests) return true;
    if (stopCondition === 'bytes' && this.bytesSent >= totalBytesLimit) return true;
    return false;
  }

  pump() {
    if (this.status !== 'running') return;

    if (this.hasReachedStopLimit()) {
      if (this.activeRequests.size === 0) {
        this.finish('completed');
      }
      return;
    }

    const now = performance.now();
    const concurrencyCap =
      this.config.rateMode === 'concurrency' ? this.config.concurrency : this.config.maxConcurrency;

    if (this.config.rateMode === 'concurrency') {
      while (
        this.status === 'running' &&
        this.activeRequests.size < concurrencyCap &&
        !this.hasReachedStopLimit()
      ) {
        this.dispatchOne();
      }
      return;
    }

    const elapsedSec = Math.max(0, (now - this.lastTokenRefill) / 1000);
    this.lastTokenRefill = now;

    const rate = this.getRatePerSecond();
    const maxBucket = this.getMaxBucketSize();
    this.tokens = Math.min(maxBucket, this.tokens + elapsedSec * rate);

    const cost = this.getTokenCostPerRequest();
    let batchGuard = 0;
    while (
      this.status === 'running' &&
      this.tokens >= cost &&
      this.activeRequests.size < concurrencyCap &&
      !this.hasReachedStopLimit() &&
      batchGuard < 500
    ) {
      this.tokens -= cost;
      this.dispatchOne();
      batchGuard++;
    }
  }

  dispatchOne() {
    const cfg = this.config;
    const body = this.payloadBuffer;
    const reqBytes = this.estimatedRequestBytes;
    const isHttps = cfg.parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers = { ...cfg.headers };
    if (body.length > 0) {
      const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
      if (!hasContentLength) {
        headers['Content-Length'] = String(body.length);
      }
    }

    this.totalSent++;
    this.bytesSent += reqBytes;
    this.tickBytesSent += reqBytes;

    const startTime = performance.now();
    let settled = false;

    const req = client.request(
      cfg.parsedUrl,
      {
        method: cfg.method,
        headers,
        agent: this.agent,
        timeout: cfg.timeoutMs,
      },
      (res) => {
        let respBytes = 0;
        res.on('data', (chunk) => {
          respBytes += chunk.length;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          this.activeRequests.delete(req);
          this.recordResult(performance.now() - startTime, res.statusCode ?? 0, respBytes, null);
          this.onRequestSettled();
        });
        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          this.activeRequests.delete(req);
          this.recordResult(performance.now() - startTime, 0, respBytes, err);
          this.onRequestSettled();
        });
      }
    );

    this.activeRequests.add(req);

    req.on('timeout', () => {
      req.destroy(new Error(`요청 타임아웃 (${cfg.timeoutMs}ms)`));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      this.activeRequests.delete(req);
      // Ignore abort errors triggered intentionally by stop()
      if (this.status !== 'running' && req.destroyed) {
        return;
      }
      this.recordResult(performance.now() - startTime, 0, 0, err);
      this.onRequestSettled();
    });

    if (body.length > 0) {
      req.end(body);
    } else {
      req.end();
    }
  }

  onRequestSettled() {
    if (this.status !== 'running') return;
    if (this.hasReachedStopLimit()) {
      if (this.activeRequests.size === 0) {
        this.finish('completed');
      }
      return;
    }
    if (this.config.rateMode === 'concurrency') {
      this.pump();
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
      this.pushError(err ? err.message : '연결 오류');
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
      this.pushError(`HTTP ${statusCode}`);
    } else if (statusCode >= 500 && statusCode < 600) {
      this.statusBuckets['5xx']++;
      this.errorCount++;
      this.tickErrors++;
      this.pushError(`HTTP ${statusCode}`);
    } else {
      this.statusBuckets.other++;
      this.successCount++;
    }
  }

  pushError(message) {
    this.recentErrors.unshift({
      time: new Date().toISOString(),
      message,
    });
    if (this.recentErrors.length > RECENT_ERRORS_LIMIT) {
      this.recentErrors.length = RECENT_ERRORS_LIMIT;
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

    for (const req of this.activeRequests) {
      req.destroy();
    }
    this.activeRequests.clear();

    if (this.agent) {
      this.agent.destroy();
      this.agent = null;
    }

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
    if (this.windowSamples.length > 4) {
      this.windowSamples.shift();
    }
    this.tickCompleted = 0;
    this.tickBytesSent = 0;
    this.tickBytesReceived = 0;
    this.tickErrors = 0;

    const snapshot = this.getSnapshot();
    this.emit('metrics', snapshot);
    return snapshot;
  }

  getSnapshot() {
    const now = this.status === 'running' ? performance.now() : (this.endedAt || performance.now());
    const elapsedMs = this.startedAt > 0 ? Math.max(0, now - this.startedAt) : 0;

    const windowSec = this.windowSamples.reduce((acc, s) => acc + s.durationMs, 0) / 1000;
    const windowCompleted = this.windowSamples.reduce((acc, s) => acc + s.completed, 0);
    const windowBytesSent = this.windowSamples.reduce((acc, s) => acc + s.bytesSent, 0);
    const windowBytesReceived = this.windowSamples.reduce((acc, s) => acc + s.bytesReceived, 0);
    const windowErrors = this.windowSamples.reduce((acc, s) => acc + s.errors, 0);

    const currentRps = windowSec > 0 ? windowCompleted / windowSec : 0;
    const currentSendBps = windowSec > 0 ? windowBytesSent / windowSec : 0;
    const currentRecvBps = windowSec > 0 ? windowBytesReceived / windowSec : 0;

    const sortedLatencies = [...this.latencyWindow].sort((a, b) => a - b);
    const avgLatencyMs = this.totalCompleted > 0 ? this.latencySum / this.totalCompleted : 0;

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
      config: this.config
        ? {
            targetUrl: this.config.targetUrl,
            method: this.config.method,
            rateMode: this.config.rateMode,
            targetRps: this.config.targetRps,
            concurrency: this.config.concurrency,
            maxConcurrency: this.config.maxConcurrency,
            targetMbps: this.config.targetMbps,
            payloadMode: this.config.payloadMode,
            payloadSizeBytes: this.config.payloadSizeBytes,
            stopCondition: this.config.stopCondition,
            durationSec: this.config.durationSec,
            totalRequests: this.config.totalRequests,
            totalBytesLimit: this.config.totalBytesLimit,
            keepAlive: this.config.keepAlive,
            insecureTls: this.config.insecureTls,
            timeoutMs: this.config.timeoutMs,
            effectivePayloadBytes: this.payloadBuffer.length,
          }
        : null,
      metrics: {
        activeConnections: this.activeRequests.size,
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
        windowErrorRate: windowCompleted > 0 ? windowErrors / windowCompleted : 0,
        latency: {
          avgMs: avgLatencyMs,
          minMs: this.latencyMin === Infinity ? 0 : this.latencyMin,
          maxMs: this.latencyMax,
          p50Ms: computePercentile(sortedLatencies, 50),
          p95Ms: computePercentile(sortedLatencies, 95),
          p99Ms: computePercentile(sortedLatencies, 99),
        },
        statusBuckets: { ...this.statusBuckets },
        statusCodes: { ...this.statusCodes },
        recentErrors: [...this.recentErrors],
      },
    };
  }
}
