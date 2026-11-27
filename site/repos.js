import {
  mergeTrending, dropStarred, dropRecentStars, hnToRepos, parseReleases, redditToRepos, mergeSources, searchToRepos, skillsToRepos, tweetsToRepos, hnWithDetails,
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
// Every GitHub-linked HN story of the last 366 days and each repo's details, collected every 4 hours by the data
// repo's Action (script/hn.js). Day to year come from these; all time adds HN's best-ranked stories ever.
const HN_STORIES = `${DATA}/hn/stories.json`;
const HN_REPOS = `${DATA}/hn/repos.json`;
const HN_FILES_MS = 10 * 60 * 1000;
const HN_TOP_MS = 60 * 60 * 1000;
// Release windows in days. releasemonitor.org offers up to 30; the year is Reddit only.
const RELEASE_DAYS = ['1', '7', '14', '30', '365'];
const RELEASE_CACHE_MS = 30 * 60 * 1000;
// Posts from r/BestGitHubRepos and other subreddits that link a repo, collected by the data repo's Action (script/reddit.js).
const REDDIT = `${DATA}/reddit/BestGitHubRepos.json`;
const DAY = 86400;
// New repos gaining stars fast, by GitHub search like repotrend.com: [days back or null for all time, minimum stars].
// All time can't be split into few enough searches (66K repos with 1K+ stars), so it keeps GitHub's 1,000 most-starred.
// 90 days to 2 years used to need 1K+ stars, which left out repos released a month or two ago that hadn't reached it.
const NEW_PERIODS = { 3: [3, 50], 30: [30, 100], 90: [90, 100], 365: [365, 300], 730: [730, 500], all: [null, 1000] };
const DAY_MS = DAY * 1000;
// Those three lists (~30,000 repos), collected by the data repo's Action (script/new.js) with the same thresholds:
// ~450 searches at GitHub's 30 a minute is far too slow to build inside Vercel's 5-minute limit.
const NEW_FILE = `${DATA}/new/repos.json`;
const NEW_FROM_FILE = ['90', '365', '730'];
const DATA_FILE_MS = 10 * 60 * 1000;
// The slow lists (Browse, Releases, Twitter, New 3/30/90 days and all time, the HN all-time top) are built every few
// hours by the data repo's Action (site/prebuild.mjs) into data/site/. Older files than this are rebuilt here instead.
const SITE_DATA = `${DATA}/site`;
const PREBUILT_MAX_MS = 12 * 60 * 60 * 1000;
// Agent skills, MCP servers and agent tools, collected every 8 hours by the data repo's Action (script/skills.js).
const SKILLS = `${DATA}/skills/skills.json`;
const SKILL_TYPES = ['all', 'mcp', 'claude', 'codex', 'agent', 'skill', 'tool'];
const SKILLS_ALL_MAX = 5000;
// Posts from followed X accounts, collected by the data repo's Action (script/twitter.js) through twitterapi.io.
const TWITTER = `${DATA}/twitter/tweets.json`;
const TWITTER_DAYS = ['1', '7', '30', '365'];
// A repo only written as "owner/repo" (no link) must have this many stars, which weeds out real-but-junk pairs.
const BARE_MIN_STARS = 20;
const STARS_MS = 60 * 1000;
// Vercel refuses function responses over 4.5 MB, so a longer list is sent in pages (?page=0, 1, ...) of this many repos.
const PAGE_ROWS = 5000;
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

// Algolia's Hacker News search: the 1,000 best-ranked GitHub-linked stories of all time (one search can't return more).
async function loadHnTop() {
  const res = await fetch(
    'https://hn.algolia.com/api/v1/search?query=github.com&restrictSearchableAttributes=url&tags=story&hitsPerPage=1000',
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

// Popular repos updated in the window: 1,000+ stars, pushed since then, most stars first.
async function fetchUpdated(days) {
  const since = new Date(Date.now() - days * DAY * 1000).toISOString().slice(0, 10);
  return (await searchAll(`stars:>1000 pushed:>=${since}`)).map((repo) => ({ ...repo, github: true }));
}

// All sources merged; if one fails the others still show, and the page says which one is missing.
async function loadReleases(days) {
  const failed = [];
  const settle = (name, job) => job.catch((err) => (console.error(err.message), failed.push(name), []));
  const [monitor, reddit, updated] = await Promise.all([
    Number(days) <= 30 ? settle('Release Monitor', fetchReleaseMonitor(days)) : [],
    settle('Reddit', fetchReddit(Number(days))),
    settle('GitHub', fetchUpdated(Number(days))),
  ]);
  if (failed.length === (Number(days) <= 30 ? 3 : 2)) throw new Error(`${failed.join(', ')} could not be loaded.`);
  // GitHub search rows come complete, so only the other sources need the slow GraphQL lookup. Starred repos among
  // them are dropped in respond(), which checks every response against the full star list.
  const checked = await enrich(mergeSources(monitor, reddit));
  const tracked = mergeSources(monitor, reddit, updated).length;
  return { ...checked, repos: mergeSources(checked.repos, updated), tracked, refreshed: Date.now(), failed };
}

async function searchPage(q, page, attempt = 1) {
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`,
    { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred', Accept: 'application/vnd.github+json' } },
  );
  // Search allows 30 requests a minute; wait until the limit resets (or as told, or back off) and retry.
  if ((res.status === 403 || res.status === 429) && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) - Date.now() / 1000;
    const wait = Math.max(Number(res.headers.get('retry-after')) || 0, reset > 0 && reset < 120 ? reset + 1 : 0, 5 * attempt);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return searchPage(q, page, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub search failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  return res.json();
}

// Every result of a search, most stars first, up to GitHub's 1,000.
async function searchAll(q) {
  const first = await searchPage(q, 1);
  const pages = Math.min(Math.ceil((first.total_count ?? 0) / 100), SEARCH_PAGES);
  const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => searchPage(q, i + 2)));
  return searchToRepos([first, ...rest].flatMap((r) => r.items ?? []));
}

// Every repo matching a search over a creation-date range. One search stops at 1,000 results, so a range with more
// is split in two until each part fits. Pages are read one at a time: search allows 30 requests a minute.
async function searchCreated(base, from, to) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const q = `${base} created:${day(from)}..${day(to)}`;
  const first = await searchPage(q, 1);
  if ((first.total_count ?? 0) > SEARCH_PAGES * 100 && to - from >= DAY_MS) {
    const mid = from + Math.floor((to - from) / DAY_MS / 2) * DAY_MS;
    return [...(await searchCreated(base, from, mid)), ...(await searchCreated(base, mid + DAY_MS, to))];
  }
  const pages = [first];
  for (let n = 2; n <= Math.min(Math.ceil((first.total_count ?? 0) / 100), SEARCH_PAGES); n++) pages.push(await searchPage(q, n));
  return pages.flatMap((r) => r.items ?? []);
}

// A collected data file, kept in memory for a few minutes (the Action only updates them every 4 hours). Lists built
// from these take seconds, so they skip the Redis cache, which can't afford multi-MB values rewritten all day.
const files = new Map();
function dataFile(url) {
  const hit = files.get(url);
  if (hit && Date.now() - hit.at < DATA_FILE_MS) return hit.data;
  const data = fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Data file failed: ${res.status} ${url.split('/data/')[1]}`);
    return res.json();
  });
  files.set(url, { at: Date.now(), data });
  data.catch(() => {
    if (files.get(url)?.data === data) files.delete(url);
  });
  return data;
}

// Search already gives every field a row needs, and respond() drops starred repos, so no GraphQL lookup here.
async function loadNew(period) {
  const [days, min] = NEW_PERIODS[period];
  const now = Date.now();
  let list;
  if (NEW_FROM_FILE.includes(period)) {
    const since = now - days * DAY_MS;
    list = searchToRepos((await dataFile(NEW_FILE)).repos.filter((r) => Date.parse(r.created_at) >= since && r.stargazers_count >= min));
  } else {
    list = days
      ? searchToRepos(await searchCreated(`stars:>=${min}`, now - days * DAY_MS, now))
      : await searchAll(`stars:>=${min}`);
  }
  // A repo near a slice's edge can show up in both slices.
  const unique = [...new Map(list.map((r) => [r.name.toLowerCase(), r])).values()];
  return { repos: unique, hiddenStarred: 0, tracked: unique.length, refreshed: now };
}

// Both collected files, kept in memory for a few minutes: the Action only updates them every 4 hours.
let hnMemo = null;
function hnFiles() {
  if (!hnMemo || Date.now() - hnMemo.at > HN_FILES_MS) {
    const data = Promise.all([HN_STORIES, HN_REPOS].map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Hacker News data file failed: ${res.status}`);
      return res.json();
    })).then(([s, r]) => ({ stories: s.stories ?? [], repos: r.repos ?? {}, updated: s.updated }));
    hnMemo = { at: Date.now(), data };
    data.catch(() => {
      if (hnMemo?.data === data) hnMemo = null;
    });
  }
  return hnMemo.data;
}

async function loadHn(period) {
  const { stories, repos, updated } = await hnFiles();
  const since = Math.floor(Date.now() / 1000) - (HN_PERIODS[period] ?? HN_PERIODS.year);
  const list = hnWithDetails(stories.filter((s) => s.created_at_i >= since), repos);
  return { repos: list, hiddenStarred: 0, tracked: list.length, refreshed: Date.parse(updated) || Date.now() };
}

// The whole collected year plus HN's best-ranked GitHub stories ever, one row per repo from its best story.
async function loadHnAll() {
  const [year, top] = await Promise.all([loadHn('year'), prebuilt('hn:top', HN_TOP_MS, loadHnTop)]);
  const best = new Map();
  for (const repo of [...year.repos, ...top.repos]) {
    const key = repo.name.toLowerCase();
    if ((best.get(key)?.hn.points ?? -1) < repo.hn.points) best.set(key, repo);
  }
  return { repos: [...best.values()], hiddenStarred: top.hiddenStarred, tracked: best.size, refreshed: year.refreshed };
}

// Every repo you starred, for lists too long to check 50 at a time over GraphQL.
async function fetchAllStars() {
  // Each page is ~500 KB and a body sometimes arrives cut off, so a page is tried up to 3 times, the body included.
  const page = async (n, attempt = 1) => {
    try {
      // Oldest first, so a star added while the pages load lands on the last page instead of pushing one past a page boundary.
      const res = await fetch(`https://api.github.com/user/starred?per_page=100&sort=created&direction=asc&page=${n}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
      });
      if (!res.ok) {
        const err = new Error(`GitHub request failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
        err.final = res.status === 401;
        throw err;
      }
      return { link: res.headers.get('link'), repos: await res.json() };
    } catch (err) {
      if (attempt < 3 && !err.final) return page(n, attempt + 1);
      throw err;
    }
  };
  const first = await page(1);
  const last = Number(first.link?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? 1);
  // A partial list would let starred repos through, so any page that still fails fails the whole load.
  const rest = await Promise.all(Array.from({ length: last - 1 }, (_, i) => page(i + 2)));
  return [first, ...rest].flatMap((p) => p.repos).map((repo) => repo.full_name.toLowerCase());
}

// The full star list, refreshed each minute. Once loaded, the previous list answers at once while the next one loads,
// so no request waits on ~16 MB of pages; the page's own check of your newest stars covers that gap.
let starsMemo = null;
let starsLoading = null;
function refreshStars() {
  starsLoading ??= fetchAllStars()
    .then((list) => {
      starsMemo = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      starsLoading = null;
    });
  return starsLoading;
}
function allStars() {
  if (!starsMemo) return refreshStars();
  if (Date.now() - starsMemo.at > STARS_MS) refreshStars().catch((err) => console.error('stars refresh:', err.message));
  return Promise.resolve(starsMemo.list);
}

// A list built by the Action, or built here (and kept in memory) when its file is missing or too old.
async function prebuilt(key, ttl, load) {
  const file = await dataFile(`${SITE_DATA}/${key.replace(':', '-')}.json`).catch(() => null);
  if (file?.data && Date.now() - file.at < PREBUILT_MAX_MS) return file.data;
  return cached(key, ttl, load);
}

async function loadSkills(type) {
  const [{ updated, repos = [] }, starred] = await Promise.all([dataFile(SKILLS), allStars()]);
  // shortcut: "all" keeps the 5,000 with most stars (the file is sorted), since every repo is heavy on phones; each
  // type still lists all of its repos. Raise SKILLS_ALL_MAX if that matters.
  const list = type === 'all' ? repos.slice(0, SKILLS_ALL_MAX) : repos.filter((r) => r.type === type);
  return { ...skillsToRepos(list, new Set(starred)), tracked: list.length, refreshed: Date.parse(updated) || Date.now() };
}

async function loadTwitter(days) {
  const res = await fetch(TWITTER);
  if (!res.ok) throw new Error(`Twitter posts file failed: ${res.status}`);
  const { updated, tweets = [] } = await res.json();
  const list = tweetsToRepos(tweets, Math.floor(Date.now() / 1000) - Number(days) * DAY);
  // The GraphQL lookup also drops names that are not real repos, which is most of the bare false matches.
  const checked = await enrich(list);
  const repos = checked.repos.filter((r) => !r.bare || r.stars >= BARE_MIN_STARS);
  return { ...checked, repos, tracked: list.length, refreshed: Date.parse(updated) || Date.now() };
}

// Newest first: the page asks for these when you come back to the tab.
async function fetchRecentStars(count) {
  const res = await fetch(`https://api.github.com/user/starred?per_page=${count}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'unstarred' },
  });
  if (!res.ok) throw new Error(`GitHub request failed: ${res.status}${res.status === 401 ? '. Check your token.' : ''}`);
  return (await res.json()).map((repo) => repo.full_name);
}

async function respond(req, res, load) {
  try {
    const [data, starred] = await Promise.all([load(), allStars()]);
    const kept = dropRecentStars(data, starred);
    // Repos with no stars are mostly empty or throwaway, so no list shows them.
    const all = { ...kept, repos: kept.repos.filter((r) => r.stars > 0) };
    const page = Math.max(Number(new URL(req.url, 'http://localhost').searchParams.get('page')) || 0, 0);
    const repos = all.repos.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
    const body = JSON.stringify({ ...all, repos, more: all.repos.length > (page + 1) * PAGE_ROWS });
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
  return respond(req, res, () => prebuilt('trending', CACHE_MS, loadTrending));
}

// GET /api/hn?period=day|week|month|year|all
export function handleHn(req, res) {
  const period = new URL(req.url, 'http://localhost').searchParams.get('period') ?? 'day';
  if (!Object.hasOwn(HN_PERIODS, period)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'period must be day, week, month, year or all.' }));
    return;
  }
  // Built from the collected files in a few seconds and kept in memory, so the other pages of a long list (HN year is
  // 6 pages) and repeat visits don't rebuild it.
  return respond(req, res, () => cached(`hn:${period}`, DATA_FILE_MS, period === 'all' ? loadHnAll : () => loadHn(period)));
}

// GET /api/releases?days=1|7|14|30|365
export function handleReleases(req, res) {
  const days = new URL(req.url, 'http://localhost').searchParams.get('days') ?? '7';
  if (!RELEASE_DAYS.includes(days)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'days must be 1, 7, 14, 30 or 365.' }));
    return;
  }
  return respond(req, res, () => prebuilt(`releases:${days}`, RELEASE_CACHE_MS, () => loadReleases(days)));
}

// GET /api/new?period=3|30|90|365|730|all
export function handleNew(req, res) {
  const period = new URL(req.url, 'http://localhost').searchParams.get('period') ?? '30';
  if (!Object.hasOwn(NEW_PERIODS, period)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'period must be 3, 30, 90, 365, 730 or all.' }));
    return;
  }
  if (NEW_FROM_FILE.includes(period)) return respond(req, res, () => cached(`new:${period}`, DATA_FILE_MS, () => loadNew(period)));
  return respond(req, res, () => prebuilt(`new:${period}`, RELEASE_CACHE_MS, () => loadNew(period)));
}

// GET /api/skills?type=all|mcp|claude|codex|agent|skill|tool
export function handleSkills(req, res) {
  const type = new URL(req.url, 'http://localhost').searchParams.get('type') ?? 'all';
  if (!SKILL_TYPES.includes(type)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: `type must be ${SKILL_TYPES.join(', ')}.` }));
    return;
  }
  return respond(req, res, () => cached(`skills:${type}`, DATA_FILE_MS, () => loadSkills(type)));
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

// GET /api/twitter?days=1|7|30|365
export function handleTwitter(req, res) {
  const days = new URL(req.url, 'http://localhost').searchParams.get('days') ?? '7';
  if (!TWITTER_DAYS.includes(days)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'days must be 1, 7, 30 or 365.' }));
    return;
  }
  return respond(req, res, () => prebuilt(`twitter:${days}`, RELEASE_CACHE_MS, () => loadTwitter(days)));
}

// What site/prebuild.mjs builds into data/site/ (key "a:b" is saved as a-b.json). Starred repos are left in: every
// response drops them against the full star list, so a file never goes stale on that.
export const PREBUILT = [
  ['trending', loadTrending],
  ...RELEASE_DAYS.map((d) => [`releases:${d}`, () => loadReleases(d)]),
  ...TWITTER_DAYS.map((d) => [`twitter:${d}`, () => loadTwitter(d)]),
  ...Object.keys(NEW_PERIODS).filter((p) => !NEW_FROM_FILE.includes(p)).map((p) => [`new:${p}`, () => loadNew(p)]),
  ['hn:top', loadHnTop],
];
