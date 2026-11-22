// Built lists are kept in this instance's memory. An old result is served at once while a new one is built.
// shortcut: memory only (the Redis copy used up Upstash's free plan), so a fresh Vercel instance builds its first copy
// itself; moving the slow lists (trending, Releases, Twitter) into the data repo's Action would fix that for good.
const memory = new Map();
const building = new Map();

// Vercel hands each request a waitUntil so work can finish after the reply; locally it just runs.
function inBackground(job) {
  globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(job);
}

function build(key, load) {
  if (building.has(key)) return building.get(key);
  const job = (async () => {
    const data = await load();
    memory.set(key, { at: Date.now(), data });
    return data;
  })().finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

export async function cached(key, ttl, load) {
  const hit = memory.get(key);
  if (!hit) return build(key, load);
  if (Date.now() - hit.at >= ttl && !building.has(key)) {
    inBackground(build(key, load).catch((err) => console.error('cache refresh:', err.message)));
  }
  return hit.data;
}
