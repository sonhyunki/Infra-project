import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TrafficEngine, normalizeConfig } from '../src/load-engine.js';

function startTargetServer() {
  let requestCount = 0;
  let totalBodyBytes = 0;
  let lastBody = '';

  const server = http.createServer((req, res) => {
    requestCount++;
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      totalBodyBytes += c.length;
    });
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      const status = Number(new URL(req.url, 'http://localhost').searchParams.get('status')) || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}/hit`,
        getStats: () => ({ requestCount, totalBodyBytes, lastBody }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function waitForCompletion(engine, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (engine.status !== 'running') {
      resolve(engine.getSnapshot());
      return;
    }
    const timer = setTimeout(() => {
      engine.off('metrics', onMetrics);
      reject(new Error('Timed out waiting for engine completion'));
    }, timeoutMs);

    const onMetrics = (snap) => {
      if (snap.status !== 'running') {
        clearTimeout(timer);
        engine.off('metrics', onMetrics);
        resolve(snap);
      }
    };
    engine.on('metrics', onMetrics);
  });
}

describe('normalizeConfig', () => {
  it('rejects non-http URLs and invalid methods', () => {
    assert.throws(() => normalizeConfig({ targetUrl: 'ftp://example.com' }), /http/);
    assert.throws(() => normalizeConfig({ targetUrl: 'not-a-url' }), /URL/);
    assert.throws(() => normalizeConfig({ targetUrl: 'http://localhost:8080', method: 'TRACE' }), /메서드/);
  });

  it('normalizes valid defaults', () => {
    const cfg = normalizeConfig({ targetUrl: 'http://127.0.0.1:8080/test' });
    assert.equal(cfg.method, 'GET');
    assert.equal(cfg.rateMode, 'rps');
    assert.equal(cfg.keepAlive, true);
  });
});

describe('TrafficEngine', () => {
  it('sends exact request count with generated payload', async () => {
    const target = await startTargetServer();
    const engine = new TrafficEngine();

    try {
      engine.start({
        targetUrl: target.url,
        method: 'POST',
        rateMode: 'concurrency',
        concurrency: 4,
        payloadMode: 'generated',
        payloadSizeBytes: 512,
        stopCondition: 'count',
        totalRequests: 25,
      });

      const snap = await waitForCompletion(engine);
      assert.equal(snap.status, 'completed');
      assert.equal(snap.metrics.totalCompleted, 25);
      assert.equal(snap.metrics.successCount, 25);
      assert.equal(snap.metrics.errorCount, 0);

      const targetStats = target.getStats();
      assert.equal(targetStats.requestCount, 25);
      assert.equal(targetStats.totalBodyBytes, 25 * 512);
    } finally {
      engine.stop();
      await target.close();
    }
  });

  it('stops when totalBytesLimit is reached', async () => {
    const target = await startTargetServer();
    const engine = new TrafficEngine();

    try {
      engine.start({
        targetUrl: target.url,
        method: 'POST',
        rateMode: 'rps',
        targetRps: 200,
        payloadMode: 'generated',
        payloadSizeBytes: 2048,
        stopCondition: 'bytes',
        totalBytesLimit: 10000,
      });

      const snap = await waitForCompletion(engine);
      assert.equal(snap.status, 'completed');
      assert.ok(snap.metrics.bytesSent >= 10000);
      assert.ok(snap.metrics.totalCompleted >= 4 && snap.metrics.totalCompleted <= 6);
    } finally {
      engine.stop();
      await target.close();
    }
  });

  it('supports live config updates while running', async () => {
    const target = await startTargetServer();
    const engine = new TrafficEngine();

    try {
      engine.start({
        targetUrl: target.url,
        method: 'POST',
        rateMode: 'rps',
        targetRps: 20,
        payloadMode: 'custom',
        customBody: 'initial',
        stopCondition: 'duration',
        durationSec: 1,
      });

      await new Promise((r) => setTimeout(r, 150));

      const updated = engine.updateConfig({
        targetRps: 100,
        payloadMode: 'custom',
        customBody: '{"updated":true}',
      });
      assert.equal(updated.config.targetRps, 100);

      const finalSnap = await waitForCompletion(engine);
      assert.equal(finalSnap.status, 'completed');
      assert.equal(target.getStats().lastBody, '{"updated":true}');
    } finally {
      engine.stop();
      await target.close();
    }
  });

  it('counts 5xx responses as errors while completing normally', async () => {
    const target = await startTargetServer();
    const engine = new TrafficEngine();

    try {
      engine.start({
        targetUrl: `${target.url}?status=503`,
        method: 'GET',
        rateMode: 'concurrency',
        concurrency: 2,
        stopCondition: 'count',
        totalRequests: 6,
      });

      const snap = await waitForCompletion(engine);
      assert.equal(snap.metrics.totalCompleted, 6);
      assert.equal(snap.metrics.errorCount, 6);
      assert.equal(snap.metrics.statusBuckets['5xx'], 6);
      assert.ok(snap.metrics.recentErrors.length > 0);
    } finally {
      engine.stop();
      await target.close();
    }
  });
});
