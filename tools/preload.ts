// Writes the boot preload list into index.html after a build: every module the
// game imports at startup, and every data file init() fetches. The browser then
// fetches them all at once instead of discovering modules one import at a time,
// and the loading screen counts them for its progress bar.
// Usage: node tools/preload.ts (run by `npm run build`).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const posix = (p: string) => p.split('\\').join('/');

/** dist/main.js and everything it imports, statically, in discovery order. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) {
      visit(join(dirname(file), m[1] ?? m[2]));
    }
  };
  visit(entry);
  return [...seen].map((f) => posix(relative(root, f)));
}

/** The data files init() fetches. */
function dataFiles(): string[] {
  const json = <T>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
  const bots = json<{ tutorial: string; circuit: string[] }>('data/personalities/index.json');
  const lessons = json<string[]>('data/lessons/index.json');
  return [
    'data/personalities/index.json', ...[bots.tutorial, ...bots.circuit].map((id) => `data/personalities/${id}.json`),
    'data/lessons/index.json', ...lessons.map((id) => `data/lessons/${id}.json`),
    'data/codex.json',
  ];
}

const modules = moduleGraph(join(root, 'dist/main.js'));
const links = [
  ...modules.map((m) => `<link rel="modulepreload" href="${m}">`),
  ...dataFiles().map((d) => `<link rel="preload" href="${d}" as="fetch" crossorigin>`),
];

const file = join(root, 'index.html');
const html = readFileSync(file, 'utf8');
const eol = html.includes('\r\n') ? '\r\n' : '\n';
const start = '<!-- boot:preload -->', end = '<!-- /boot:preload -->';
const i = html.indexOf(start), j = html.indexOf(end);
if (i < 0 || j < 0) throw new Error(`index.html needs ${start} and ${end} markers`);
const block = [start, ...links.map((l) => `  ${l}`), `  ${end}`].join(eol);
const next = html.slice(0, i) + block + html.slice(j + end.length);
if (next !== html) writeFileSync(file, next);
console.log(`index.html: preloading ${modules.length} modules and ${links.length - modules.length} data files`);
