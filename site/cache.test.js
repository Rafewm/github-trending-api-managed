import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// In-memory stand-in for Upstash's REST API, just GET and SET (with NX).
const kv = new Map();
const upstash = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const [command, key, value, ...opts] = JSON.parse(raw);
  let result = null;
  if (command === 'GET') result = kv.get(key) ?? null;
  else if (command === 'SET' && !(opts.includes('NX') && kv.has(key))) (kv.set(key, value), (result = 'OK'));
  res.end(JSON.stringify({ result }));
}).listen(0);
process.env.KV_REST_API_URL = `http://127.0.0.1:${upstash.address().port}`;
process.env.KV_REST_API_TOKEN = 'store-token';
test.after(() => upstash.close());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a new instance answers from the store without rebuilding', async () => {
  const first = await import('./cache.js?instance=1');
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await first.cached('k', 60_000, load), { n: 1 });
  assert.deepEqual(await first.cached('k', 60_000, load), { n: 1 });

  const second = await import('./cache.js?instance=2');
  assert.deepEqual(await second.cached('k', 60_000, load), { n: 1 });
  assert.equal(loads, 1);
});

test('a stale result is served at once and rebuilt in the background', async () => {
  const cache = await import('./cache.js?instance=3');
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await cache.cached('s', 0, load), { n: 1 });
  assert.deepEqual(await cache.cached('s', 0, load), { n: 1 });
  await wait(50);
  assert.equal(loads, 2);
  assert.equal(JSON.parse(kv.get('unstarred:cache:s')).data.n, 2);
});

test('a failed first build surfaces the error', async () => {
  const cache = await import('./cache.js?instance=4');
  await assert.rejects(cache.cached('f', 60_000, async () => { throw new Error('boom'); }), /boom/);
});
