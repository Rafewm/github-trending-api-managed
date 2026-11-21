const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Every Hacker News story that links a GitHub repo, from the Algolia HN API (https://hn.algolia.com/api),
// kept for 366 days in data/hn/stories.json, with each repo's GitHub details in data/hn/repos.json.
// Algolia returns at most 1,000 results per search, so it searches one day at a time and splits a busier window.
const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?query=github.com&restrictSearchableAttributes=url&tags=story&hitsPerPage=1000';
const STORIES = path.resolve(__dirname, DATA_BASE_URL, 'hn', 'stories.json');
const REPOS = path.resolve(__dirname, DATA_BASE_URL, 'hn', 'repos.json');
const DAY = 86400;
const KEEP_DAYS = 366;
// Points and comments still change for a few days after posting, so those days are fetched again.
const REFETCH_DAYS = 3;
// Repo details: re-checked weekly while a story is recent, otherwise a few thousand of the oldest per run.
const RECENT_DAYS = 30;
const CHECK_EVERY_MS = 7 * DAY * 1000;
const ROTATE = 3000;
const BATCH = 50;
const PARALLEL = 3;
const FIELDS = 'nameWithOwner description primaryLanguage{name color} stargazerCount pushedAt isArchived repositoryTopics(first:10){nodes{topic{name}}}';
// GitHub paths that are site pages rather than an owner (same list as the site's repoFromUrl).
const NOT_OWNERS = new Set([
  'about', 'apps', 'collections', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'login',
  'marketplace', 'orgs', 'pricing', 'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function repoFromUrl (url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(String(url || ''));
  return m && !NOT_OWNERS.has(m[1].toLowerCase()) && m[2] !== '.' && m[2] !== '..' ? `${m[1]}/${m[2]}` : null;
}

async function search (from, to, attempt = 1) {
  const res = await fetch(`${SEARCH}&numericFilters=created_at_i>${from},created_at_i<=${to}`);
  if (!res.ok) {
    if (attempt < 4) {
      await sleep(5000 * attempt);
      return search(from, to, attempt + 1);
    }
    throw new Error(`Algolia ${res.status}`);
  }
  const body = await res.json();
  // Over 1,000 in one window: the rest would be cut off, so search each half instead.
  if (body.nbHits > body.hits.length && to - from > 60) {
    const mid = Math.floor((from + to) / 2);
    return [...await search(from, mid), ...await search(mid, to)];
  }
  return body.hits;
}

async function fetchStories (from, to) {
  const days = [];
  for (let t = from; t < to; t += DAY) days.push([t, Math.min(t + DAY, to)]);
  const hits = [];
  for (let i = 0; i < days.length; i += 4) {
    const found = await Promise.all(days.slice(i, i + 4).map(([a, b]) => search(a, b)));
    hits.push(...found.flat());
    if (i % 40 === 0) console.log('hn days', i + found.length, '/', days.length, hits.length, 'stories');
  }
  return hits;
}

async function graphql (batch, attempt = 1) {
  const query = batch.map((name, i) => {
    const [owner, repo] = name.split('/');
    return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){${FIELDS}}`;
  });
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'github-trending-api' },
    body: JSON.stringify({ query: `{${query.join(' ')}}` })
  });
  if ((res.status >= 500 || res.status === 403 || res.status === 429) && attempt < 5) {
    await sleep((Number(res.headers.get('retry-after')) || 10 * attempt) * 1000);
    return graphql(batch, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const body = await res.json();
  if (!body.data) throw new Error(`GitHub GraphQL: ${(body.errors || [])[0]?.message || 'no data'}`);
  return batch.map((_, i) => body.data[`r${i}`]);
}

function details (node) {
  if (!node) return { missing: true, checked: Date.now() };
  return {
    name: node.nameWithOwner,
    description: String(node.description || '').slice(0, 300),
    language: node.primaryLanguage?.name || '',
    languageColor: node.primaryLanguage?.color || '',
    stars: node.stargazerCount,
    pushedAt: node.pushedAt,
    archived: node.isArchived,
    topics: node.repositoryTopics.nodes.map(n => n.topic.name),
    checked: Date.now()
  };
}

async function updateRepos (stories, saved) {
  const now = Date.now();
  const recent = new Set(stories.filter(s => s.created_at_i * 1000 > now - RECENT_DAYS * DAY * 1000).map(s => s.repo.toLowerCase()));
  const names = new Map(stories.map(s => [s.repo.toLowerCase(), s.repo]));
  const repos = {};
  for (const key of names.keys()) if (saved[key]) repos[key] = saved[key];
  const due = [...names.keys()].filter(key => !repos[key] || (recent.has(key) && now - repos[key].checked > CHECK_EVERY_MS));
  const others = [...names.keys()].filter(key => repos[key] && !due.includes(key))
    .sort((a, b) => repos[a].checked - repos[b].checked).slice(0, ROTATE);
  const todo = [...due, ...others];
  console.log('hn repos', names.size, 'to check', todo.length);
  for (let i = 0; i < todo.length; i += BATCH * PARALLEL) {
    const batches = [];
    for (let j = i; j < Math.min(i + BATCH * PARALLEL, todo.length); j += BATCH) batches.push(todo.slice(j, j + BATCH));
    try {
      const results = await Promise.all(batches.map(batch => graphql(batch.map(key => names.get(key)))));
      batches.forEach((batch, b) => batch.forEach((key, k) => { repos[key] = details(results[b][k]); }));
    } catch (error) {
      // Keep the details already saved; the next run tries these again.
      console.error('Error hn repos:', error.message);
      break;
    }
    if (i % (BATCH * PARALLEL * 20) === 0) console.log('hn repos checked', Math.min(i + BATCH * PARALLEL, todo.length), '/', todo.length);
  }
  return repos;
}

async function updateHn () {
  const now = Math.floor(Date.now() / 1000);
  const saved = existsSync(STORIES) ? JSON.parse(readFileSync(STORIES, 'utf8')).stories : [];
  const savedRepos = existsSync(REPOS) ? JSON.parse(readFileSync(REPOS, 'utf8')).repos : {};
  const newest = saved.length ? Math.max(...saved.map(s => s.created_at_i)) : 0;
  const from = Math.max(now - KEEP_DAYS * DAY, newest - REFETCH_DAYS * DAY);
  const byId = new Map(saved.map(s => [s.objectID, s]));
  try {
    for (const hit of await fetchStories(from, now)) {
      const repo = repoFromUrl(hit.url);
      if (!repo || !/^\d+$/.test(String(hit.objectID))) continue;
      byId.set(String(hit.objectID), {
        objectID: String(hit.objectID),
        title: hit.title || '',
        url: hit.url,
        repo,
        points: hit.points || 0,
        num_comments: hit.num_comments || 0,
        created_at_i: hit.created_at_i
      });
    }
  } catch (error) {
    // Without every day the gap would look like quiet days, so keep the last good files.
    return console.error('Error hn stories, files kept:', error.message);
  }
  const stories = [...byId.values()]
    .filter(s => s.created_at_i >= now - KEEP_DAYS * DAY)
    .sort((a, b) => b.created_at_i - a.created_at_i);
  const repos = await updateRepos(stories, savedRepos);
  mkdirSync(path.dirname(STORIES), { recursive: true });
  const updated = new Date().toISOString();
  writeFileSync(STORIES, JSON.stringify({ updated, stories }), 'utf-8');
  writeFileSync(REPOS, JSON.stringify({ updated, repos }), 'utf-8');
  console.log('hn', stories.length, 'stories,', Object.keys(repos).length, 'repos saved');
}

if (require.main === module) updateHn();

module.exports = {
  updateHn,
  repoFromUrl
}
