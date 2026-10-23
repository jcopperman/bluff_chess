// Local dev server: `npm start` builds once and serves; `npm run dev` also
// rebuilds on change (tsc --watch). ES modules and fetch() need http://, not file://.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

createServer(async (req, res) => {
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
}).listen(port, () => console.log(`Bluff Chess running at http://localhost:${port}`));
