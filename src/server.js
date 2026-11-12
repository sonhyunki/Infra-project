import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TrafficEngine } from './load-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ALLOWED_STATIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'browser-engine.js']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('요청 본문 크기가 허용 한도를 초과했습니다.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('올바른 JSON 형식이 아닙니다.');
  }
}

async function handleEcho(req, res, urlObj) {
  let receivedBytes = 0;
  for await (const chunk of req) {
    receivedBytes += chunk.length;
  }

  const delayMs = Math.min(30000, Math.max(0, Number(urlObj.searchParams.get('delay')) || 0));
  const statusParam = Number(urlObj.searchParams.get('status'));
  const statusCode = Number.isInteger(statusParam) && statusParam >= 100 && statusParam <= 599 ? statusParam : 200;

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  sendJson(res, statusCode, {
    ok: statusCode < 400,
    method: req.method,
    path: urlObj.pathname,
    receivedBytes,
    timestamp: Date.now(),
  });
}

async function serveStatic(res, pathname) {
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!ALLOWED_STATIC_FILES.has(relPath)) {
    sendJson(res, 404, { error: '페이지를 찾을 수 없습니다.' });
    return;
  }

  const resolved = path.resolve(ROOT_DIR, relPath);
  if (!resolved.startsWith(ROOT_DIR + path.sep)) {
    sendJson(res, 403, { error: '접근이 거부되었습니다.' });
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      sendJson(res, 404, { error: '페이지를 찾을 수 없습니다.' });
      return;
    }
    sendJson(res, 500, { error: '정적 파일을 읽는 중 오류가 발생했습니다.' });
  }
}

/**
 * Creates the HTTP dashboard, control API, SSE telemetry stream, and built-in /echo target.
 */
export function createAppServer() {
  const engine = new TrafficEngine();
  const sseClients = new Set();

  const broadcastMetrics = (snapshot) => {
    const line = `event: metrics\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of sseClients) {
      client.write(line);
    }
  };

  engine.on('metrics', broadcastMetrics);

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = urlObj;

    try {
      if (pathname === '/echo' || pathname.startsWith('/echo/')) {
        await handleEcho(req, res, urlObj);
        return;
      }

      if (pathname === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, engine.getSnapshot());
        return;
      }

      if (pathname === '/api/test/start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const snapshot = engine.start(body);
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/test/stop' && req.method === 'POST') {
        const snapshot = engine.stop();
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/test/config' && req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const snapshot = engine.updateConfig(body);
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: metrics\ndata: ${JSON.stringify(engine.getSnapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(res, pathname);
        return;
      }

      sendJson(res, 405, { error: '허용되지 않는 메서드입니다.' });
    } catch (err) {
      sendJson(res, 400, { error: err?.message || '요청 처리 중 오류가 발생했습니다.' });
    }
  });

  server.on('close', () => {
    engine.stop();
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
  });

  return { server, engine };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3456;
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createAppServer();
  server.listen(port, host, () => {
    console.log(`Traffic Tester running at http://${host}:${port}`);
  });
}
