// src/server.mjs
// Minimal zero-dependency HTTP console for the claim-memory layer.
// Listens on 127.0.0.1:3457 (deliberately distinct from DSH's 3456).
// Pure node:http — no Express, no bundler, static HTML served from /public.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClaimMemory } from './memory_sdk.mjs';
import { seedDemoScenario } from './demo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_PORT = 3457;
const DEFAULT_HOST = '127.0.0.1';

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createServer({ dataDir, defaultNamespace = 'default' } = {}) {
  const memories = new Map(); // namespace -> claim memory instance
  function memFor(namespace) {
    const ns = namespace || defaultNamespace;
    if (!memories.has(ns)) {
      memories.set(ns, createClaimMemory({ dataDir, namespace: ns }));
    }
    return memories.get(ns);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/index.html') {
        const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        return sendText(res, 200, html, MIME['.html']);
      }
      if (pathname.startsWith('/static/')) {
        const rel = pathname.replace('/static/', '');
        const ext = path.extname(rel);
        try {
          const content = await readFile(path.join(PUBLIC_DIR, rel), 'utf8');
          return sendText(res, 200, content, MIME[ext] || 'text/plain; charset=utf-8');
        } catch {
          return send(res, 404, { error: 'not found' });
        }
      }

      if (pathname === '/api/health') {
        return send(res, 200, { ok: true, port: DEFAULT_PORT });
      }

      if (pathname === '/api/recall' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.recall(
          {
            taskText: body.taskText || '',
            activeFiles: body.activeFiles || [],
            activeModules: body.activeModules || [],
            toolName: body.toolName || null,
          },
          { topK: body.topK || 5 }
        );
        return send(res, 200, result);
      }

      if (pathname === '/api/compile' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.compileInjection(
          {
            taskText: body.taskText || '',
            activeFiles: body.activeFiles || [],
            activeModules: body.activeModules || [],
            toolName: body.toolName || null,
          },
          { topK: body.topK || 5 }
        );
        return send(res, 200, result);
      }

      if (pathname === '/api/propose' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.propose(body);
        return send(res, 200, result);
      }

      if (pathname === '/api/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.verify(body.block_id, {
          ok: !!body.ok,
          evidenceRef: body.evidenceRef,
          note: body.note,
          currentRound: body.currentRound,
        });
        return send(res, 200, result);
      }

      if (pathname === '/api/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.restore(body.block_id, { mode: body.mode, reason: body.reason });
        return send(res, 200, result);
      }

      if (pathname === '/api/archive' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.store.updateClaim(
          body.block_id,
          { status: 'archived' },
          { at: new Date().toISOString(), actor: 'console', action: 'archive', delta: 0, reason: body.reason || 'manual archive', evidence_ref: null }
        );
        return send(res, 200, result);
      }

      if (pathname === '/api/pin' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.store.updateClaim(
          body.block_id,
          { utility: 1.5 },
          { at: new Date().toISOString(), actor: 'console', action: 'pin', delta: 0, reason: 'manual pin to max utility', evidence_ref: null }
        );
        return send(res, 200, result);
      }

      if (pathname === '/api/audit-compaction' && req.method === 'POST') {
        const body = await readBody(req);
        const mem = memFor(body.namespace);
        const result = await mem.auditCompaction(body.summaryText || '', {
          sessionRef: body.sessionRef,
          roundAt: typeof body.roundAt === 'number' ? body.roundAt : 0,
          activeFiles: body.activeFiles || [],
        });
        return send(res, 200, result);
      }

      if (pathname === '/api/flow' && req.method === 'GET') {
        const mem = memFor(url.searchParams.get('namespace'));
        const result = await mem.evaluateCompactionFlow();
        return send(res, 200, result);
      }

      if (pathname === '/api/verdict' && req.method === 'GET') {
        const mem = memFor(url.searchParams.get('namespace'));
        const result = await mem.getVerdict();
        return send(res, 200, result);
      }

      if (pathname === '/api/inspect' && req.method === 'GET') {
        const mem = memFor(url.searchParams.get('namespace'));
        const result = await mem.inspect();
        return send(res, 200, result);
      }

      if (pathname === '/api/demo/seed' && req.method === 'POST') {
        // Always writes into the isolated 'demo' namespace — never 'default'
        // or any namespace the caller is actively working in.
        const result = await seedDemoScenario({ dataDir, namespace: 'demo' });
        memories.delete('demo'); // force memFor('demo') to re-read the freshly seeded state next time
        return send(res, 200, { namespace: 'demo', measurements: result.measurements, logs: result.logs });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: err.message, stack: err.stack });
    }
  });

  return server;
}

export function startServer({ dataDir, port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createServer({ dataDir });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// Allow `node src/server.mjs` direct execution.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = process.env.CLAIM_MEMORY_DATA_DIR || path.join(__dirname, '..', 'data');
  startServer({ dataDir }).then((server) => {
    const addr = server.address();
    console.log(`claim-memory console listening on http://${addr.address}:${addr.port}`);
  });
}
