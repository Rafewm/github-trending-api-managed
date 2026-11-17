import { createHash, timingSafeEqual } from 'node:crypto';
import { REPO_NAME, cleanSnapshot } from './trending.js';

// Vercel's Upstash integration names these KV_*, a direct Upstash setup names them UPSTASH_REDIS_*.
const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HIDE_KEY = process.env.HIDE_KEY;
const TOKEN = process.env.UNSTARRED_TOKEN || process.env.GITHUB_TOKEN;
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

function checkKey(req) {
  if (!HIDE_KEY) throw new HttpError(503, 'HIDE_KEY is not set on the server.');
  if (!timingSafeEqual(digest(req.headers['x-hide-key'] ?? ''), digest(HIDE_KEY))) {
    throw new HttpError(401, 'Wrong hide key.');
  }
}

function fail(res, err) {
  if (!err.status) console.error(err);
  res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: err.status ? err.message : 'Internal error.' }));
}

async function writeList(req, key) {
  checkKey(req);
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
    fail(res, err);
  }
};

export const handleHidden = listHandler('unstarred:hidden');
// Repos saved for later: same rules and key as the hidden list, separate storage.
export const handleTracked = listHandler('unstarred:tracked');

// POST {"name": "owner/repo"} stars the repo on GitHub with the server's token. Needs the hide key like list writes.
export async function handleStar(req, res) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    checkKey(req);
    const { name } = (await readBody(req)) ?? {};
    // REPO_NAME lets "." and ".." through, which fetch would resolve into a different API path.
    if (typeof name !== 'string' || !REPO_NAME.test(name) || name.split('/').some((p) => p === '.' || p === '..')) {
      throw new HttpError(400, 'Invalid repository name.');
    }
    const gh = await fetch(`https://api.github.com/user/starred/${name}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred', Accept: 'application/vnd.github+json', 'Content-Length': '0' },
    });
    // GitHub answers 403 or 404 when the token may read but not star, depending on the token type.
    if (gh.status === 403 || gh.status === 404) {
      throw new HttpError(502, `GitHub refused the star (${gh.status}). The server's token needs the Starring permission.`);
    }
    if (!gh.ok) throw new HttpError(502, `GitHub star failed: ${gh.status}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ starred: name }));
  } catch (err) {
    fail(res, err);
  }
}
