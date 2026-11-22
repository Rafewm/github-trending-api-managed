import { createHash, timingSafeEqual } from 'node:crypto';
import { REPO_NAME, cleanSnapshot } from './trending.js';

// The Hidden and Track lists are JSON files on the data repo's `lists` branch, written through GitHub's contents API:
// free, with no storage or bandwidth quota, and every change is a commit, so the branch history is a full backup.
// (They were in Upstash Redis until its free plan's bandwidth ran out.) The server token needs Contents write there.
const LISTS_API = process.env.LISTS_API || 'https://api.github.com/repos/Rafewm/github-trending-api-managed';
const BRANCH = 'lists';
const HIDE_KEY = process.env.HIDE_KEY;
const TOKEN = process.env.UNSTARRED_TOKEN || process.env.GITHUB_TOKEN;
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function github(path, { accept = 'application/vnd.github+json', ...opts } = {}) {
  const res = await fetch(`${LISTS_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred', Accept: accept, ...opts.headers },
  });
  if (res.status === 403 || res.status === 401) {
    throw new HttpError(502, `List store refused (${res.status}). The server's token needs Contents write on the data repo.`);
  }
  return res;
}

// The `lists` branch head: it changes with every saved change, so the page only refetches the lists when it differs.
async function listsVersion() {
  const res = await github(`/git/ref/heads/${BRANCH}`);
  if (!res.ok) throw new HttpError(502, `List store failed: ${res.status}`);
  return (await res.json()).object.sha;
}

async function readList(name) {
  const res = await github(`/contents/lists/${name}.json?ref=${BRANCH}`, { accept: 'application/vnd.github.raw' });
  if (res.status === 404) return {};
  if (!res.ok) throw new HttpError(502, `List store failed: ${res.status}`);
  return res.json();
}

// The file's blob sha, which a write must name so a change made meanwhile is never overwritten.
async function fileSha(name) {
  const res = await github(`/contents/lists/${name}.json?ref=${BRANCH}`, { accept: 'application/vnd.github.object' });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new HttpError(502, `List store failed: ${res.status}`);
  return (await res.json()).sha;
}

// Applies the change to the newest copy and saves it as one commit; a write that raced another is redone on top of it.
async function saveList(name, repos, unhide, attempt = 1) {
  const [list, sha] = await Promise.all([readList(name), fileSha(name)]);
  for (const r of repos) list[r.name] = r;
  for (const n of unhide) delete list[n];
  const res = await github(`/contents/lists/${name}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${name}: +${repos.length} -${unhide.length}`,
      content: Buffer.from(JSON.stringify(list, null, 1)).toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if ((res.status === 409 || res.status === 422) && attempt < 4) return saveList(name, repos, unhide, attempt + 1);
  if (!res.ok) throw new HttpError(502, `List store failed: ${res.status}`);
  return { version: (await res.json()).commit.sha, count: Object.keys(list).length };
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

async function writeList(req, name) {
  checkKey(req);
  const { hide = [], unhide = [] } = (await readBody(req)) ?? {};
  if (!Array.isArray(hide) || !Array.isArray(unhide)) throw new HttpError(400, 'hide and unhide must be arrays.');
  const repos = hide.map(cleanSnapshot);
  // Validate everything before writing, so a bad entry never leaves a half-applied change.
  if (repos.includes(null) || !unhide.every((n) => typeof n === 'string' && REPO_NAME.test(n))) {
    throw new HttpError(400, 'Invalid repository name.');
  }
  return saveList(name, repos, unhide);
}

// GET returns the list; POST {hide: [repo], unhide: [name]} adds or removes repos and returns only {version, count}:
// sending the whole list back on every click is what used up the old store's bandwidth.
const listHandler = (name) => async (req, res) => {
  try {
    let body;
    if (req.method === 'POST') body = await writeList(req, name);
    else if (req.method === 'GET') body = await readList(name);
    else throw new HttpError(405, 'Method not allowed.');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (err) {
    fail(res, err);
  }
};

export const handleHidden = listHandler('hidden');
// Repos saved for later: same rules and key as the hidden list, separate file.
export const handleTracked = listHandler('tracked');

// GET {version}: cheap check the page makes on load and focus before downloading the lists again.
export async function handleListsVersion(req, res) {
  try {
    const version = await listsVersion();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version }));
  } catch (err) {
    fail(res, err);
  }
}

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
