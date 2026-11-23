// Run by the data repo's Action after it collects its data: builds the site's slow lists into data/site/, so the site
// only reads files instead of spending 15-50 s per list. A list that fails keeps its last good file.
// Usage: node site/prebuild.mjs [output dir]   (GITHUB_TOKEN set; defaults to ../data/site next to this file)
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREBUILT } from './repos.js';

const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../data/site', import.meta.url)));
mkdirSync(dir, { recursive: true });
let failed = 0;
for (const [key, load] of PREBUILT) {
  const started = Date.now();
  try {
    const data = await load();
    writeFileSync(resolve(dir, `${key.replace(':', '-')}.json`), JSON.stringify({ at: Date.now(), data }));
    console.log('prebuilt', key, data.repos.length, 'repos', `${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    failed++;
    console.error('Error prebuild', key, err.message);
  }
}
// Fail the step only if nothing could be built; one bad source shouldn't hide the rest.
if (failed === PREBUILT.length) process.exitCode = 1;
