import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// In-memory stand-in for Upstash's REST API: one JSON command array per POST, one hash per key.
const hashes = new Map();
const hash = (key) => hashes.get(key) ?? hashes.set(key, new Map()).get(key);
const store = hash('unstarred:hidden');
const upstash = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer store-token') return res.writeHead(401).end('{"error":"unauthorized"}');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const [command, key, ...args] = JSON.parse(raw);
  const store = hash(key);
  let result;
  if (command === 'HSET') for (let i = 0; i < args.length; i += 2) store.set(args[i], args[i + 1]);
  else if (command === 'HDEL') args.forEach((f) => store.delete(f));
  else if (command === 'HGETALL') result = [...store].flat();
  res.end(JSON.stringify({ result: result ?? 1 }));
}).listen(0);

process.env.KV_REST_API_URL = `http://127.0.0.1:${upstash.address().port}`;
process.env.KV_REST_API_TOKEN = 'store-token';
process.env.HIDE_KEY = 'right-key';
const { handleHidden, handleTracked, handleStar } = await import('./hidden.js');
const app = createServer(handleHidden).listen(0);
const trackApp = createServer(handleTracked).listen(0);
const url = `http://127.0.0.1:${app.address().port}/api/hidden`;
const trackUrl = `http://127.0.0.1:${trackApp.address().port}/api/tracked`;
test.after(() => {
  app.close();
  trackApp.close();
  upstash.close();
});

const post = (body, key = 'right-key') =>
  fetch(url, { method: 'POST', headers: { 'X-Hide-Key': key }, body: JSON.stringify(body) });

test('starts empty', async () => {
  assert.deepEqual(await (await fetch(url)).json(), {});
});

test('rejects writes without the right key', async () => {
  const res = await post({ hide: [{ name: 'a/b' }] }, 'wrong');
  assert.equal(res.status, 401);
  assert.equal(store.size, 0);
});

test('stores sanitized snapshots and returns the new list', async () => {
  const res = await post({ hide: [{ name: 'a/b', stars: '<b>x</b>', avatar: 'javascript:alert(1)', topics: ['cli'], day: { add: 5, pct: 'x' } }] });
  assert.equal(res.status, 200);
  const repo = (await res.json())['a/b'];
  assert.equal(repo.stars, 0);
  assert.equal(repo.avatar, '');
  assert.deepEqual(repo.day, { add: 5, pct: null });
  assert.deepEqual(repo.topics, ['cli']);
});

test('rejects a batch with any invalid name without writing part of it', async () => {
  const res = await post({ hide: [{ name: 'c/d' }, { name: '../../etc' }] });
  assert.equal(res.status, 400);
  assert.equal(store.has('c/d'), false);
});

test('unhide removes the repo', async () => {
  const res = await post({ unhide: ['a/b'] });
  assert.deepEqual(await res.json(), {});
});

test('tracked list is stored apart from the hidden list and needs the key', async () => {
  const track = (body, key = 'right-key') =>
    fetch(trackUrl, { method: 'POST', headers: { 'X-Hide-Key': key }, body: JSON.stringify(body) });
  assert.equal((await track({ hide: [{ name: 'x/y' }] }, 'wrong')).status, 401);
  const res = await track({ hide: [{ name: 'x/y' }] });
  assert.deepEqual(Object.keys(await res.json()), ['x/y']);
  assert.equal(store.has('x/y'), false);
  assert.deepEqual(await (await fetch(url)).json(), {});
});

test('star needs the key, POST and a safe repo name before calling GitHub', async () => {
  const starApp = createServer(handleStar).listen(0);
  const starUrl = `http://127.0.0.1:${starApp.address().port}/api/star`;
  const star = (name, key = 'right-key', method = 'POST') =>
    fetch(starUrl, { method, headers: { 'X-Hide-Key': key }, body: method === 'GET' ? undefined : JSON.stringify({ name }) });
  try {
    assert.equal((await star('a/b', 'wrong')).status, 401);
    assert.equal((await star('a/b', 'right-key', 'GET')).status, 405);
    for (const bad of ['../x', 'a/..', 'a/.', 'no-slash', 42]) assert.equal((await star(bad)).status, 400, String(bad));
  } finally {
    starApp.close();
  }
});
