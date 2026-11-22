import test from 'node:test';
import assert from 'node:assert/strict';
import { cached } from './cache.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a fresh result is built once and then served from memory', async () => {
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await cached('k', 60_000, load), { n: 1 });
  assert.deepEqual(await cached('k', 60_000, load), { n: 1 });
  assert.equal(loads, 1);
});

test('a stale result is served at once and rebuilt in the background', async () => {
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await cached('s', 0, load), { n: 1 });
  assert.deepEqual(await cached('s', 0, load), { n: 1 });
  await wait(50);
  assert.equal(loads, 2);
  assert.deepEqual(await cached('s', 60_000, load), { n: 2 });
});

test('a failed first build surfaces the error', async () => {
  await assert.rejects(cached('f', 60_000, async () => { throw new Error('boom'); }), /boom/);
});
