import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../src/server.js';

function startApp() {
  const { server, engine } = createAppServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        engine,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('HTTP API & Dashboard Server', () => {
  it('serves root frontend assets and blocks non-allowlisted files', async () => {
    const app = await startApp();
    try {
      for (const route of ['/', '/index.html', '/style.css', '/app.js', '/browser-engine.js']) {
        const res = await fetch(`${app.baseUrl}${route}`);
        assert.equal(res.status, 200, `Expected 200 for ${route}`);
      }

      const htmlRes = await fetch(`${app.baseUrl}/`);
      const html = await htmlRes.text();
      assert.ok(html.includes('./style.css'));
      assert.ok(html.includes('./app.js'));

      for (const blocked of ['/package.json', '/src/server.js', '/../package.json']) {
        const badRes = await fetch(`${app.baseUrl}${blocked}`);
        assert.ok(badRes.status === 403 || badRes.status === 404, `Expected blocked for ${blocked}`);
      }
    } finally {
      await app.close();
    }
  });

  it('runs start, live config patch, status, and stop against /echo', async () => {
    const app = await startApp();
    try {
      const echoRes = await fetch(`${app.baseUrl}/echo?status=201`, {
        method: 'POST',
        body: 'hello',
      });
      assert.equal(echoRes.status, 201);
      const echoJson = await echoRes.json();
      assert.equal(echoJson.receivedBytes, 5);

      const startRes = await fetch(`${app.baseUrl}/api/test/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `${app.baseUrl}/echo`,
          method: 'POST',
          rateMode: 'rps',
          targetRps: 30,
          payloadMode: 'generated',
          payloadSizeBytes: 256,
          stopCondition: 'manual',
        }),
      });
      assert.equal(startRes.status, 200);
      const started = await startRes.json();
      assert.equal(started.status, 'running');

      const patchRes = await fetch(`${app.baseUrl}/api/test/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rateMode: 'bandwidth',
          targetMbps: 2,
          payloadSizeBytes: 1024,
        }),
      });
      assert.equal(patchRes.status, 200);
      const patched = await patchRes.json();
      assert.equal(patched.config.rateMode, 'bandwidth');
      assert.equal(patched.config.payloadSizeBytes, 1024);

      await new Promise((r) => setTimeout(r, 300));

      const statusRes = await fetch(`${app.baseUrl}/api/status`);
      const statusJson = await statusRes.json();
      assert.ok(statusJson.metrics.totalCompleted >= 1);

      const stopRes = await fetch(`${app.baseUrl}/api/test/stop`, { method: 'POST' });
      assert.equal(stopRes.status, 200);
      const stopped = await stopRes.json();
      assert.equal(stopped.status, 'stopped');
    } finally {
      await app.close();
    }
  });

  it('streams metrics over SSE', async () => {
    const app = await startApp();
    try {
      const firstChunk = await new Promise((resolve, reject) => {
        const req = http.get(`${app.baseUrl}/api/events`, (res) => {
          assert.equal(res.statusCode, 200);
          res.once('data', (chunk) => {
            req.destroy();
            resolve(chunk.toString('utf8'));
          });
        });
        req.on('error', reject);
      });
      assert.ok(firstChunk.includes('event: metrics'));
      assert.ok(firstChunk.includes('"status":"idle"'));
    } finally {
      await app.close();
    }
  });
});
