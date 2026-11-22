import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// In-memory stand-in for the GitHub API calls the list store makes on the `lists` branch: the branch ref, a file as
// raw JSON or as an object with its sha, and PUT with a sha check. Also counts the bytes sent back to the site.
const files = new Map();
let commits = 0;
let sent = 0;
const sha = (text) => `s${text.length}-${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
const github = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer gh-token') return res.writeHead(401).end('{}');
  const reply = (status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    sent += text.length;
    res.writeHead(status).end(text);
  };
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/git/ref/heads/lists') return reply(200, { object: { sha: `c${commits}` } });
  const name = pathname.match(/^\/contents\/lists\/(\w+)\.json$/)?.[1];
  if (!name) return reply(404, {});
  const text = files.get(name);
  if (req.method === 'GET') {
    if (text === undefined) return reply(404, {});
    return req.headers.accept === 'application/vnd.github.raw' ? reply(200, text) : reply(200, { sha: sha(text), content: '' });
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if ((text === undefined ? undefined : sha(text)) !== body.sha) return reply(409, {});
  files.set(name, Buffer.from(body.content, 'base64').toString('utf8'));
  return reply(200, { commit: { sha: `c${++commits}` } });
}).listen(0);

process.env.LISTS_API = `http://127.0.0.1:${github.address().port}`;
process.env.UNSTARRED_TOKEN = 'gh-token';
process.env.HIDE_KEY = 'right-key';
const { handleHidden, handleTracked, handleStar, handleListsVersion } = await import('./hidden.js');
const app = createServer(handleHidden).listen(0);
const trackApp = createServer(handleTracked).listen(0);
const versionApp = createServer(handleListsVersion).listen(0);
const url = `http://127.0.0.1:${app.address().port}/api/hidden`;
const trackUrl = `http://127.0.0.1:${trackApp.address().port}/api/tracked`;
const versionUrl = `http://127.0.0.1:${versionApp.address().port}/api/lists-version`;
test.after(() => {
  app.close();
  trackApp.close();
  versionApp.close();
  github.close();
});

const post = (body, key = 'right-key') =>
  fetch(url, { method: 'POST', headers: { 'X-Hide-Key': key }, body: JSON.stringify(body) });
const stored = (name) => JSON.parse(files.get(name) ?? '{}');

test('starts empty', async () => {
  assert.deepEqual(await (await fetch(url)).json(), {});
});

test('rejects writes without the right key', async () => {
  const res = await post({ hide: [{ name: 'a/b' }] }, 'wrong');
  assert.equal(res.status, 401);
  assert.equal(files.size, 0);
});

test('stores sanitized snapshots as one commit and replies with only the version and count', async () => {
  const res = await post({ hide: [{ name: 'a/b', stars: '<b>x</b>', avatar: 'javascript:alert(1)', topics: ['cli'], day: { add: 5, pct: 'x' } }] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 'c1', count: 1 });
  const repo = stored('hidden')['a/b'];
  assert.equal(repo.stars, 0);
  assert.equal(repo.avatar, '');
  assert.deepEqual(repo.day, { add: 5, pct: null });
  assert.deepEqual(repo.topics, ['cli']);
});

test('the version changes with each save, so the page refetches only then', async () => {
  const before = (await (await fetch(versionUrl)).json()).version;
  await post({ hide: [{ name: 'v/w' }] });
  const after = (await (await fetch(versionUrl)).json()).version;
  assert.notEqual(before, after);
  await post({ unhide: ['v/w'] });
});

test('a reply stays small however long the list is', async () => {
  await post({ hide: Array.from({ length: 2000 }, (_, i) => ({ name: `big/repo${i}`, description: 'x'.repeat(200) })) });
  const res = await post({ hide: [{ name: 'one/more' }] });
  const text = await res.text();
  assert.ok(text.length < 100, text);
  assert.equal(JSON.parse(text).count, 2002);
  await post({ unhide: [...Array.from({ length: 2000 }, (_, i) => `big/repo${i}`), 'one/more'] });
});

test('a save that raced another is redone on top of it instead of overwriting it', async () => {
  await Promise.all([post({ hide: [{ name: 'r/one' }] }), post({ hide: [{ name: 'r/two' }] })]);
  assert.ok(stored('hidden')['r/one'] && stored('hidden')['r/two']);
  await post({ unhide: ['r/one', 'r/two'] });
});

test('rejects a batch with any invalid name without writing part of it', async () => {
  const res = await post({ hide: [{ name: 'c/d' }, { name: '../../etc' }] });
  assert.equal(res.status, 400);
  assert.equal(stored('hidden')['c/d'], undefined);
});

test('unhide removes the repo', async () => {
  await post({ unhide: ['a/b'] });
  assert.deepEqual(await (await fetch(url)).json(), {});
});

test('tracked list is stored apart from the hidden list and needs the key', async () => {
  const track = (body, key = 'right-key') =>
    fetch(trackUrl, { method: 'POST', headers: { 'X-Hide-Key': key }, body: JSON.stringify(body) });
  assert.equal((await track({ hide: [{ name: 'x/y' }] }, 'wrong')).status, 401);
  await track({ hide: [{ name: 'x/y' }] });
  assert.deepEqual(Object.keys(await (await fetch(trackUrl)).json()), ['x/y']);
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
