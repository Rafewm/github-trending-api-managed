import { redis } from './hidden.js';

// Results are kept in Redis too, so a fresh Vercel instance answers at once instead of
// rebuilding for half a minute. Old results are served while a new one is built.
const KEEP_SECONDS = 24 * 60 * 60;
const LOCK_SECONDS = 120;
const storeKey = (key) => `unstarred:cache:${key}`;
const memory = new Map();
const building = new Map();

// Vercel hands each request a waitUntil so work can finish after the reply; locally it just runs.
function inBackground(job) {
  globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(job);
}

async function readStored(key) {
  try {
    return JSON.parse(await redis(['GET', storeKey(key)]));
  } catch {
    return null;
  }
}

function build(key, load) {
  if (building.has(key)) return building.get(key);
  const job = (async () => {
    const data = await load();
    const hit = { at: Date.now(), data };
    memory.set(key, hit);
    await redis(['SET', storeKey(key), JSON.stringify(hit), 'EX', KEEP_SECONDS]).catch((err) =>
      console.error('cache write:', err.message),
    );
    return data;
  })().finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

export async function cached(key, ttl, load) {
  let hit = memory.get(key);
  if (!hit && (hit = await readStored(key))) memory.set(key, hit);
  if (!hit) return build(key, load);
  const stale = () => Date.now() - hit.at >= ttl;
  // Another instance may already have stored a newer result.
  if (stale() && !building.has(key)) {
    const stored = await readStored(key);
    if (stored?.at > hit.at) memory.set(key, (hit = stored));
  }
  if (stale() && !building.has(key)) {
    // One instance rebuilds at a time, so visitors can't multiply the GitHub queries.
    const job = redis(['SET', `${storeKey(key)}:lock`, '1', 'NX', 'EX', LOCK_SECONDS])
      .catch(() => 'OK')
      .then((got) => got && build(key, load))
      .catch((err) => console.error('cache refresh:', err.message));
    inBackground(job);
  }
  return hit.data;
}
