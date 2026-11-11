import { createHash, timingSafeEqual } from 'node:crypto';
import { REPO_NAME, cleanSnapshot } from './trending.js';

// Vercel's Upstash integration names these KV_*, a direct Upstash setup names them UPSTASH_REDIS_*.
const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HIDE_KEY = process.env.HIDE_KEY;
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function redis(command) {
  if (!STORE_URL || !STORE_TOKEN) throw new HttpError(503, 'List store is not configured.');
  const res = await fetch(STORE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE_TOKEN}` },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new HttpError(502, `List store failed: ${body.error ?? res.status}`);
  return body.result;
}

async function readList(key) {
  const flat = await redis(['HGETALL', key]);
  const list = {};
  for (let i = 0; i < flat.length; i += 2) list[flat[i]] = JSON.parse(flat[i + 1]);
  return list;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

async function writeList(req, key) {
  if (!HIDE_KEY) throw new HttpError(503, 'HIDE_KEY is not set on the server.');
  if (!timingSafeEqual(digest(req.headers['x-hide-key'] ?? ''), digest(HIDE_KEY))) {
    throw new HttpError(401, 'Wrong hide key.');
  }
  const { hide = [], unhide = [] } = (await readBody(req)) ?? {};
  if (!Array.isArray(hide) || !Array.isArray(unhide)) throw new HttpError(400, 'hide and unhide must be arrays.');
  const repos = hide.map(cleanSnapshot);
  // Validate everything before writing, so a bad entry never leaves a half-applied change.
  if (repos.includes(null) || !unhide.every((n) => typeof n === 'string' && REPO_NAME.test(n))) {
    throw new HttpError(400, 'Invalid repository name.');
  }
  if (repos.length) await redis(['HSET', key, ...repos.flatMap((r) => [r.name, JSON.stringify(r)])]);
  if (unhide.length) await redis(['HDEL', key, ...unhide]);
}

// GET returns the list; POST {hide: [repo], unhide: [name]} adds or removes repos and returns the new list.
const listHandler = (key) => async (req, res) => {
  try {
    if (req.method === 'POST') await writeList(req, key);
    else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const body = JSON.stringify(await readList(key));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (err) {
    if (!err.status) console.error(err);
    res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: err.status ? err.message : 'Internal error.' }));
  }
};

export const handleHidden = listHandler('unstarred:hidden');
// Repos saved for later: same rules and key as the hidden list, separate storage.
export const handleTracked = listHandler('unstarred:tracked');
