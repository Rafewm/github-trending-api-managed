const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Every repo created in the last 2 years that has 1,000+ stars, from GitHub search, for the Unstarred site's
// New tab (its 1-year and 2-year lists) in data/new/repos.json. The site can't build this live: it takes ~90
// searches and GitHub allows 30 a minute, which runs past Vercel's 5-minute limit.
const MIN_STARS = 1000;
const DAYS = 731;
const DAY_MS = 86400 * 1000;
const FILE = path.resolve(__dirname, DATA_BASE_URL, 'new', 'repos.json');
// One search returns at most 1,000 results, 100 per page.
const PAGES = 10;
// Search allows 30 requests a minute.
const PAUSE_MS = 2100;
// A list that suddenly lost more than this share is more likely a failed run than real changes, so it isn't saved.
const MAX_DROP = 0.2;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = ms => new Date(ms).toISOString().slice(0, 10);

async function searchPage (q, page, attempt = 1) {
  await sleep(PAUSE_MS);
  const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`, {
    headers: {
      'User-Agent': 'github-trending-api',
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 6) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) - Date.now() / 1000;
    await sleep(Math.max(Number(res.headers.get('retry-after')) || 0, reset > 0 && reset < 120 ? reset + 1 : 0, 10 * attempt) * 1000);
    return searchPage(q, page, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub search ${res.status} for ${q}`);
  return res.json();
}

// A date range with more than 1,000 matches is split in two until each part fits.
async function searchCreated (from, to) {
  const q = `stars:>=${MIN_STARS} created:${day(from)}..${day(to)}`;
  const first = await searchPage(q, 1);
  if (first.total_count > PAGES * 100 && to - from >= DAY_MS) {
    const mid = from + Math.floor((to - from) / DAY_MS / 2) * DAY_MS;
    return [...await searchCreated(from, mid), ...await searchCreated(mid + DAY_MS, to)];
  }
  const items = [...first.items];
  for (let n = 2; n <= Math.min(Math.ceil(first.total_count / 100), PAGES); n++) items.push(...(await searchPage(q, n)).items);
  console.log('new', day(from), day(to), first.total_count);
  return items;
}

// The fields the site's searchToRepos reads, under the same names as GitHub's search results.
function toEntry (repo) {
  return {
    full_name: repo.full_name,
    description: String(repo.description || '').slice(0, 300),
    language: repo.language || '',
    stargazers_count: repo.stargazers_count,
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    archived: repo.archived,
    topics: (repo.topics || []).slice(0, 10),
    owner: { avatar_url: (repo.owner && repo.owner.avatar_url) || '' }
  };
}

async function updateNew () {
  const now = Date.now();
  let items;
  try {
    items = await searchCreated(now - DAYS * DAY_MS, now);
  } catch (error) {
    return console.error('Error new, file kept:', error.message);
  }
  // A repo near a slice's edge can come back from both slices.
  const repos = [...new Map(items.map(r => [r.full_name.toLowerCase(), toEntry(r)])).values()]
    .sort((a, b) => b.stargazers_count - a.stargazers_count);
  const before = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).repos.length : 0;
  if (before && repos.length < before * (1 - MAX_DROP)) {
    return console.error(`new: ${repos.length} repos, down from ${before}; file kept`);
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), repos }), 'utf-8');
  console.log('new', repos.length, 'repos saved');
}

if (require.main === module) updateNew();

module.exports = {
  updateNew
}
