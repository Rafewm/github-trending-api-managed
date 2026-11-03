import { mergeTrending, dropStarred, dropRecentStars, hnToRepos } from './trending.js';

const TOKEN = process.env.UNSTARRED_TOKEN || process.env.GITHUB_TOKEN;
const DATA = 'https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data';
const CACHE_MS = 5 * 60 * 1000;
const BATCH = 50;
const PERIODS = { day: 'daily', week: 'weekly', month: 'monthly' };
// shortcut: only these languages are fetched (repo has ~700 files per period), add to the list to widen the pool.
const LANGUAGES = [
  'all', 'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c++', 'c', 'c#', 'swift', 'kotlin',
  'ruby', 'php', 'html', 'css', 'shell', 'dart', 'vue', 'zig', 'lua', 'jupyter-notebook', 'scala', 'elixir', 'nix',
];
// Seconds back from now; null means all time. Older periods barely change, so they are cached longer.
const HN_PERIODS = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400, all: null };
const HN_CACHE_MS = { day: CACHE_MS, week: CACHE_MS, month: 60 * 60 * 1000, year: 60 * 60 * 1000, all: 60 * 60 * 1000 };
const FIELDS =
  'nameWithOwner description primaryLanguage{name color} stargazerCount pushedAt isArchived viewerHasStarred owner{avatarUrl(size:40)} repositoryTopics(first:20){nodes{topic{name}}}';

async function fetchList(period, language) {
  const res = await fetch(`${DATA}/${PERIODS[period]}/${encodeURIComponent(language)}.json`);
  if (res.status === 404) return { period, items: [], pubDate: null };
  if (!res.ok) throw new Error(`Trending data fetch failed: ${res.status}`);
  const body = await res.json();
  return { period, items: body.items ?? [], pubDate: body.pubDate };
}

async function fetchNodes(batch, attempt = 1) {
  const query = batch.map((repo, i) => {
    const [owner, name] = repo.name.split('/');
    return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${FIELDS}}`;
  });
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
    body: JSON.stringify({ query: `{${query.join(' ')}}` }),
  });
  // GitHub's GraphQL times out on heavy queries now and then.
  if (res.status >= 500 && attempt < 3) return fetchNodes(batch, attempt + 1);
  if (!res.ok) throw new Error(`GitHub request failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  const body = await res.json();
  // A failed star check must surface: otherwise starred repos would leak into the list.
  const fatal = (body.errors ?? []).filter((e) => e.type !== 'NOT_FOUND');
  if (fatal.length || !body.data) throw new Error(`GitHub GraphQL error: ${fatal[0]?.message ?? 'no data'}`);
  return batch.map((_, i) => body.data[`r${i}`]);
}

// Adds GitHub details to each repo and drops the ones you starred.
async function enrich(list) {
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  const nodes = (await Promise.all(batches.map((batch) => fetchNodes(batch)))).flat();
  return dropStarred(list, nodes);
}

async function loadTrending() {
  const jobs = LANGUAGES.flatMap((lang) => Object.keys(PERIODS).map((period) => fetchList(period, lang)));
  const lists = await Promise.all(jobs);
  const trending = mergeTrending(lists);
  const refreshed = lists.map((l) => Date.parse(l.pubDate) || 0).reduce((a, b) => Math.max(a, b), 0);
  return { ...(await enrich(trending)), tracked: trending.length, refreshed };
}

// Algolia's Hacker News search: GitHub-linked stories, highest points first, 1000 at most.
async function loadHn(period) {
  const since = HN_PERIODS[period];
  const filter = since === null ? '' : `&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - since}`;
  const res = await fetch(
    `https://hn.algolia.com/api/v1/search?query=github.com&restrictSearchableAttributes=url&tags=story&hitsPerPage=1000${filter}`,
  );
  if (!res.ok) throw new Error(`Hacker News search failed: ${res.status}`);
  const list = hnToRepos((await res.json()).hits ?? []);
  return { ...(await enrich(list)), tracked: list.length, refreshed: Date.now() };
}

// Newest first, so this catches anything starred since the cache was filled.
async function fetchRecentStars() {
  const res = await fetch('https://api.github.com/user/starred?per_page=100', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
  });
  if (!res.ok) throw new Error(`GitHub request failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  return (await res.json()).map((repo) => repo.full_name);
}

const cache = new Map();
function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = load();
  cache.set(key, { at: Date.now(), data });
  data.catch(() => {
    if (cache.get(key)?.data === data) cache.delete(key);
  });
  return data;
}

async function respond(res, load) {
  try {
    const [data, recentStars] = await Promise.all([load(), fetchRecentStars()]);
    const body = JSON.stringify(dropRecentStars(data, recentStars));
    // On Vercel the CDN answers repeat hits, so visitors can't drain the token's GitHub quota.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=30' });
    res.end(body);
  } catch (err) {
    console.error(err.message);
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

export function handleRepos(req, res) {
  return respond(res, () => cached('trending', CACHE_MS, loadTrending));
}

// GET /api/hn?period=day|week|month|year|all
export function handleHn(req, res) {
  const period = new URL(req.url, 'http://localhost').searchParams.get('period') ?? 'day';
  if (!Object.hasOwn(HN_PERIODS, period)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'period must be day, week, month, year or all.' }));
    return;
  }
  return respond(res, () => cached(`hn:${period}`, HN_CACHE_MS[period], () => loadHn(period)));
}
