// Local dev server: `npm start` builds once and serves; `npm run dev` also
// rebuilds on change (tsc --watch). ES modules and fetch() need http://, not file://.
// Also hosts online rooms under /api (see rooms.ts).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms, RoomError } from './rooms.ts';
import type { RoomMessage } from '../net/protocol.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 8080;
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8',
};

if (process.argv.includes('--watch')) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  spawn(process.execPath, [tsc, '-p', join(root, 'tsconfig.json'), '--watch', '--preserveWatchOutput'], { stdio: 'inherit' });
}

const rooms = new Rooms();
setInterval(() => rooms.sweep(), 10 * 60 * 1000).unref();

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 16_000) reject(new RoomError('Request too large.', 413));
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new RoomError('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** The caller's IP. Fly's proxy sets Fly-Client-IP; elsewhere the socket is the caller. */
function address(req: IncomingMessage): string {
  const fly = req.headers['fly-client-ip'];
  return (typeof fly === 'string' && fly) || req.socket.remoteAddress || '';
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** GET /api/rooms (health check), POST /api/rooms, POST /api/rooms/:code/{join,action,rematch}, GET /api/rooms/:code/events?token= (server-sent events). */
async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2);
  // Any page may use the rooms (the itch.io build is on another site). Seats are held by
  // tokens in the request, not cookies, so there is nothing for another site to borrow.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
    res.end();
    return;
  }
  try {
    if (req.method === 'GET' && parts.length === 0) return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && parts.length === 0) {
      const body = await readJson(req);
      return sendJson(res, 200, rooms.create(body.name, body.color === 'white' || body.color === 'black' ? body.color : 'random', address(req)));
    }
    const [code, verb] = parts;
    if (req.method === 'POST' && verb === 'join') return sendJson(res, 200, rooms.join(code, (await readJson(req)).name));
    if (req.method === 'POST' && verb === 'action') {
      const body = await readJson(req);
      rooms.act(code, String(body.token), body.action as never);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && verb === 'rematch') {
      rooms.rematch(code, String((await readJson(req)).token));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && verb === 'events') {
      const token = url.searchParams.get('token') ?? '';
      const send = (msg: RoomMessage) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
      // Validate before switching to a stream, so a bad code gets a normal error.
      rooms.check(code, token);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const stop = rooms.subscribe(code, token, send);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        stop();
      });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (res.headersSent) return;
    sendJson(res, e instanceof RoomError ? e.status : 500, { error: e instanceof Error ? e.message : 'Server error' });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/rooms')) return api(req, res, url);
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (path.startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const file = join(root, path || 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Bluff Chess running at http://localhost:${port} (online rooms on the same address)`));
