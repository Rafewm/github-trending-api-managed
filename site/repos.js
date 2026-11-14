import {
  mergeTrending, dropStarred, dropRecentStars, hnToRepos, parseReleases, redditToRepos, mergeSources, searchToRepos, skillsToRepos,
} from './trending.js';
import { cached } from './cache.js';

const TOKEN = process.env.UNSTARRED_TOKEN || process.env.GITHUB_TOKEN;
const DATA = 'https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data';
const CACHE_MS = 5 * 60 * 1000;
const BATCH = 50;
const PARALLEL = 3;
const PERIODS = { day: 'daily', week: 'weekly', month: 'monthly' };
// shortcut: only these languages are fetched (repo has ~700 files per period), add to the list to widen the pool.
const LANGUAGES = [
  'all', 'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c++', 'c', 'c#', 'swift', 'kotlin',
  'ruby', 'php', 'html', 'css', 'shell', 'dart', 'vue', 'zig', 'lua', 'jupyter-notebook', 'scala', 'elixir', 'nix',
];
// Seconds back from now; null means all time. Older periods barely change, so they are cached longer.
const HN_PERIODS = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400, all: null };
const HN_CACHE_MS = { day: CACHE_MS, week: CACHE_MS, month: 60 * 60 * 1000, year: 60 * 60 * 1000, all: 60 * 60 * 1000 };
// Release windows in days. releasemonitor.org offers up to 30; the year is Reddit only.
const RELEASE_DAYS = ['1', '7', '14', '30', '365'];
const RELEASE_CACHE_MS = 30 * 60 * 1000;
// r/BestGitHubRepos posts, collected every 4 hours by the data repo's Action (script/reddit.js).
const REDDIT = `${DATA}/reddit/BestGitHubRepos.json`;
const DAY = 86400;
// New repos gaining stars fast, by GitHub search like repotrend.com: [days back or null for all time, minimum stars].
const NEW_PERIODS = { 3: [3, 50], 30: [30, 100], 90: [90, 1000], 730: [730, 10000], all: [null, 50000] };
// Agent skills, MCP servers and agent tools, collected every 8 hours by the data repo's Action (script/skills.js).
const SKILLS = `${DATA}/skills/skills.json`;
const SKILL_TYPES = ['all', 'mcp', 'claude', 'codex', 'agent', 'skill', 'tool'];
const SKILLS_ALL_MAX = 5000;
// GitHub search stops at 1,000 results, 100 per page.
const SEARCH_PAGES = 10;
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
  // 403/429 here is the secondary rate limit for bursts; wait as told (or back off) and retry.
  if ((res.status === 403 || res.status === 429) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) || 5 * attempt;
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return fetchNodes(batch, attempt + 1);
  }
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
  // A few queries at a time: GitHub refuses large bursts of parallel GraphQL requests.
  const nodes = [];
  for (let i = 0; i < batches.length; i += PARALLEL) {
    const results = await Promise.all(batches.slice(i, i + PARALLEL).map((batch) => fetchNodes(batch)));
    nodes.push(...results.flat());
  }
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

// releasemonitor.org's text list of notable GitHub releases, best first, 500 at most.
async function fetchReleaseMonitor(days) {
  const res = await fetch(
    `https://releasemonitor.org/?days=${days}&filter=all&latest=1&sort=score_desc&text=true`,
    { headers: { 'User-Agent': 'unstarred' } },
  );
  if (!res.ok) throw new Error(`Release Monitor failed: ${res.status}`);
  const list = parseReleases(await res.text());
  if (!list.length) throw new Error('Release Monitor returned no releases.');
  return list;
}

// The archive allows about one request every few seconds, too slow to ask live, so the data repo
// collects the posts and this reads its file.
async function fetchReddit(days) {
  const res = await fetch(REDDIT);
  if (!res.ok) throw new Error(`Reddit posts file failed: ${res.status}`);
  const since = Math.floor(Date.now() / 1000) - days * DAY;
  return redditToRepos(((await res.json()).posts ?? []).filter((post) => post.created_utc >= since));
}

// Both sources merged; if one fails the other still shows, and the page says which one is missing.
async function loadReleases(days) {
  const failed = [];
  const settle = (name, job) => job.catch((err) => (console.error(err.message), failed.push(name), []));
  const [monitor, reddit] = await Promise.all([
    Number(days) <= 30 ? settle('Release Monitor', fetchReleaseMonitor(days)) : [],
    settle('Reddit', fetchReddit(Number(days))),
  ]);
  if (failed.length === (Number(days) <= 30 ? 2 : 1)) throw new Error(`${failed.join(' and ')} could not be loaded.`);
  const list = mergeSources(monitor, reddit);
  return { ...(await enrich(list)), tracked: list.length, refreshed: Date.now(), failed };
}

async function searchPage(q, page, attempt = 1) {
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`,
    { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred', Accept: 'application/vnd.github+json' } },
  );
  // Search allows 30 requests a minute; wait as told (or back off) and retry.
  if ((res.status === 403 || res.status === 429) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) || 10 * attempt;
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return searchPage(q, page, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub search failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  return res.json();
}

async function loadNew(period) {
  const [days, min] = NEW_PERIODS[period];
  const since = days && new Date(Date.now() - days * DAY * 1000).toISOString().slice(0, 10);
  const q = `stars:>=${min}${since ? ` created:>=${since}` : ''}`;
  const first = await searchPage(q, 1);
  const pages = Math.min(Math.ceil((first.total_count ?? 0) / 100), SEARCH_PAGES);
  const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => searchPage(q, i + 2)));
  const list = searchToRepos([first, ...rest].flatMap((r) => r.items ?? []));
  return { ...(await enrich(list)), tracked: list.length, refreshed: Date.now() };
}

// Every repo you starred, for lists too long to check 50 at a time over GraphQL.
async function fetchAllStars() {
  const page = (n) =>
    fetch(`https://api.github.com/user/starred?per_page=100&page=${n}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
    });
  const first = await page(1);
  if (!first.ok) throw new Error(`GitHub request failed: ${first.status}${first.status === 401 ? '. Check your token.' : ''}`);
  const last = Number(first.headers.get('link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? 1);
  const rest = await Promise.all(Array.from({ length: last - 1 }, (_, i) => page(i + 2)));
  const failed = rest.find((res) => !res.ok);
  // A partial list would let starred repos through, so any failed page fails the whole load.
  if (failed) throw new Error(`GitHub request failed: ${failed.status}`);
  const pages = await Promise.all([first, ...rest].map((res) => res.json()));
  return pages.flat().map((repo) => repo.full_name.toLowerCase());
}

async function loadSkills(type) {
  const [res, starred] = await Promise.all([fetch(SKILLS), cached('stars:all', RELEASE_CACHE_MS, fetchAllStars)]);
  if (!res.ok) throw new Error(`Skills file failed: ${res.status}`);
  const { updated, repos = [] } = await res.json();
  // shortcut: "all" keeps the 5,000 with most stars (the file is sorted), since every repo is over Upstash's 10 MB
  // value limit and slow on phones; each type still lists all of its repos. Page it server-side if that matters.
  const list = type === 'all' ? repos.slice(0, SKILLS_ALL_MAX) : repos.filter((r) => r.type === type);
  return { ...skillsToRepos(list, new Set(starred)), tracked: list.length, refreshed: Date.parse(updated) || Date.now() };
}

// Newest first, so this catches anything starred since the cache was filled.
async function fetchRecentStars(count = 100) {
  const res = await fetch(`https://api.github.com/user/starred?per_page=${count}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
  });
  if (!res.ok) throw new Error(`GitHub request failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  return (await res.json()).map((repo) => repo.full_name);
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

// GET /api/releases?days=1|7|14|30|365
export function handleReleases(req, res) {
  const days = new URL(req.url, 'http://localhost').searchParams.get('days') ?? '7';
  if (!RELEASE_DAYS.includes(days)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'days must be 1, 7, 14, 30 or 365.' }));
    return;
  }
  return respond(res, () => cached(`releases:${days}`, RELEASE_CACHE_MS, () => loadReleases(days)));
}

// GET /api/new?period=3|30|90|730|all
export function handleNew(req, res) {
  const period = new URL(req.url, 'http://localhost').searchParams.get('period') ?? '30';
  if (!Object.hasOwn(NEW_PERIODS, period)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'period must be 3, 30, 90, 730 or all.' }));
    return;
  }
  return respond(res, () => cached(`new:${period}`, RELEASE_CACHE_MS, () => loadNew(period)));
}

// GET /api/skills?type=all|mcp|claude|codex|agent|skill|tool
export function handleSkills(req, res) {
  const type = new URL(req.url, 'http://localhost').searchParams.get('type') ?? 'all';
  if (!SKILL_TYPES.includes(type)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: `type must be ${SKILL_TYPES.join(', ')}.` }));
    return;
  }
  return respond(res, () => cached(`skills:${type}`, RELEASE_CACHE_MS, () => loadSkills(type)));
}

// GET /api/stars: your 10 newest stars, uncached, so the page can drop a repo as soon as you come back from starring it.
export async function handleStars(req, res) {
  try {
    const body = JSON.stringify(await fetchRecentStars(10));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (err) {
    console.error(err.message);
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
