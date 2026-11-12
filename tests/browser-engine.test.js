import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserTrafficEngine } from '../browser-engine.js';

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
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
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

function waitForBrowserEngineDone(engine, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (engine.status !== 'running') {
      resolve(engine.getSnapshot());
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (engine.status !== 'running') {
        clearInterval(timer);
        resolve(engine.getSnapshot());
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for BrowserTrafficEngine'));
      }
    }, 20);
  });
}

describe('BrowserTrafficEngine (GitHub Pages / Static Mode)', () => {
  it('validates URL and no-cors method constraints', () => {
    const engine = new BrowserTrafficEngine();
    assert.throws(() => engine.start({ targetUrl: 'ftp://example.com', method: 'GET' }), /http/);
    assert.throws(
      () => engine.start({ targetUrl: 'https://example.com', method: 'PUT', noCors: true }),
      /no-cors/
    );
  });

  it('sends exact count and payload bytes to target server', async () => {
    const target = await startTargetServer();
    const snapshots = [];
    const engine = new BrowserTrafficEngine((snap) => snapshots.push(snap));

    try {
      engine.start({
        targetUrl: target.url,
        method: 'POST',
        rateMode: 'concurrency',
        concurrency: 3,
        payloadMode: 'generated',
        payloadSizeBytes: 300,
        stopCondition: 'count',
        totalRequests: 15,
      });

      const snap = await waitForBrowserEngineDone(engine);
      assert.equal(snap.status, 'completed');
      assert.equal(snap.metrics.totalCompleted, 15);
      assert.equal(snap.metrics.successCount, 15);
      assert.equal(target.getStats().requestCount, 15);
      assert.equal(target.getStats().totalBodyBytes, 15 * 300);
      assert.ok(snapshots.length >= 1);
    } finally {
      engine.stop();
      await target.close();
    }
  });

  it('supports live config updates and records HTTP 5xx errors', async () => {
    const target = await startTargetServer();
    const engine = new BrowserTrafficEngine();

    try {
      engine.start({
        targetUrl: `${target.url}?status=502`,
        method: 'POST',
        rateMode: 'rps',
        targetRps: 30,
        payloadMode: 'custom',
        customBody: 'v1',
        stopCondition: 'duration',
        durationSec: 0.5,
      });

      await new Promise((r) => setTimeout(r, 120));
      engine.updateConfig({ customBody: 'v2', targetRps: 60 });

      const snap = await waitForBrowserEngineDone(engine);
      assert.equal(snap.status, 'completed');
      assert.ok(snap.metrics.totalCompleted >= 5);
      assert.equal(snap.metrics.statusBuckets['5xx'], snap.metrics.totalCompleted);
      assert.ok(snap.metrics.recentErrors.some((e) => e.message === 'HTTP 502'));
      assert.equal(target.getStats().lastBody, 'v2');
    } finally {
      engine.stop();
      await target.close();
    }
  });
});
