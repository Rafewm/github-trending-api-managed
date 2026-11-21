const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Daily copies of the lists that exist in one place only, kept in data/backup/. Git keeps every day's version.
// - starred.json: Rafewm's GitHub stars, newest first, with when each was starred.
// - hidden.json, tracked.json: the Unstarred site's Hidden and Track lists, read from its API (reading needs no key).
// Restore a list by POSTing its entries back: {"hide": [...entries]} to /api/hidden or /api/tracked with X-Hide-Key.
const USER = 'Rafewm';
const SITE = 'https://unstarred-ten.vercel.app';
const DIR = path.resolve(__dirname, DATA_BASE_URL, 'backup');
// A list that suddenly lost more than this share is more likely a failed read than real removals, so it isn't saved.
const MAX_DROP = 0.2;

const headers = {
  'User-Agent': 'github-trending-api',
  Accept: 'application/vnd.github.star+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
};

async function fetchStars () {
  const page = async (n) => {
    // Oldest first, so a star added during the run lands on the last page instead of pushing one past a page.
    const res = await fetch(`https://api.github.com/users/${USER}/starred?per_page=100&sort=created&direction=asc&page=${n}`, { headers });
    if (!res.ok) throw new Error(`GitHub stars page ${n}: ${res.status}`);
    return res;
  };
  const first = await page(1);
  const last = Number(first.headers.get('link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? 1);
  const pages = [await first.json()];
  for (let n = 2; n <= last; n++) pages.push(await (await page(n)).json());
  return pages.flat()
    .map(s => ({
      name: s.repo.full_name,
      starred_at: s.starred_at,
      description: s.repo.description || '',
      language: s.repo.language || '',
      stars: s.repo.stargazers_count
    }))
    .sort((a, b) => b.starred_at.localeCompare(a.starred_at));
}

async function fetchList (list) {
  const res = await fetch(`${SITE}/api/${list}`);
  if (!res.ok) throw new Error(`${list} list: ${res.status}`);
  const entries = await res.json();
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${list} list: not an object`);
  return entries;
}

function save (file, data, count) {
  const target = path.join(DIR, file);
  const before = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')).count : 0;
  if (before && count < before * (1 - MAX_DROP)) {
    return console.error(`backup ${file}: ${count} entries, down from ${before}; kept the last copy`);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(target, JSON.stringify({ updated: new Date().toISOString(), count, data }, null, 1), 'utf-8');
  console.log('backup', file, count);
}

async function backup () {
  const jobs = [
    ['starred.json', fetchStars, (d) => d.length],
    ['hidden.json', () => fetchList('hidden'), (d) => Object.keys(d).length],
    ['tracked.json', () => fetchList('tracked'), (d) => Object.keys(d).length]
  ];
  let failed = 0;
  for (const [file, load, count] of jobs) {
    try {
      const data = await load();
      save(file, data, count(data));
    } catch (error) {
      failed++;
      console.error(`Error backup ${file}:`, error.message);
    }
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) backup();

module.exports = {
  backup
}
