// Gathers the files a static host needs into build/web/ after a build: the page,
// styles, fonts, data and the compiled game, without source maps. CI pushes that
// folder to itch.io with butler; zip it to upload by hand.
// Usage: npm run package (builds first).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'build/web');
const files = ['index.html', 'ui/styles.css', 'assets', 'data', 'dist'];

if (!existsSync(join(root, 'dist/main.js'))) throw new Error('No build in dist/: run `npm run build` first');
rmSync(out, { recursive: true, force: true });
for (const f of files) {
  cpSync(join(root, f), join(out, f), { recursive: true, filter: (src) => !src.endsWith('.map') });
}
console.log(`build/web: ${files.join(', ')}`);
