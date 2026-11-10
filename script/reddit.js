const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Collects r/BestGitHubRepos posts that link a GitHub repo, from the Arctic Shift Reddit archive
// (https://github.com/ArthurHeitmann/arctic_shift/tree/master/api), into data/reddit/BestGitHubRepos.json.
// Each run only asks for posts newer than the newest saved one and keeps the last year.
const API = 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=BestGitHubRepos'
  + '&fields=id,title,url,selftext,num_comments,created_utc&limit=100&sort=asc';
const FILE = path.resolve(__dirname, DATA_BASE_URL, 'reddit', 'BestGitHubRepos.json');
const KEEP_SECONDS = 365 * 86400;
const MAX_PAGES = 200;
// The archive is free and throttles hard: a request right after another gets 422 "Timeout. Maybe slow down a bit".
const PAUSE_MS = 5000;
const GITHUB_LINK = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/gi;
// GitHub paths that are site pages rather than an owner.
const NOT_OWNERS = new Set([
  'about', 'apps', 'collections', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'login',
  'marketplace', 'orgs', 'pricing', 'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchPage (after, attempt = 1) {
  const res = await fetch(`${API}&after=${after}`, { headers: { 'User-Agent': 'github-trending-api' } });
  const body = await res.json().catch(() => ({}));
  if ((res.status === 422 || res.status === 429 || body.error) && attempt < 6) {
    const wait = Math.max(Number(res.headers.get('x-ratelimit-reset')) || 0, 5 * attempt);
    await sleep(wait * 1000);
    return fetchPage(after, attempt + 1);
  }
  if (!res.ok || body.error) throw new Error(`Arctic Shift: ${body.error || res.status}`);
  return body.data || [];
}

// First owner/repo link in the post's url or body, or null.
function repoLink (post) {
  for (const m of `${post.url || ''} ${post.selftext || ''}`.matchAll(GITHUB_LINK)) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '').replace(/\.+$/, '');
    if (repo && !NOT_OWNERS.has(owner.toLowerCase())) return `https://github.com/${owner}/${repo}`;
  }
  return null;
}

function write (byId, cutoff) {
  const posts = [...byId.values()]
    .filter(post => post.created_utc >= cutoff)
    .sort((a, b) => b.created_utc - a.created_utc);
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), posts }), 'utf-8');
  return posts.length;
}

async function updateReddit () {
  const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).posts : [];
  const cutoff = Math.floor(Date.now() / 1000) - KEEP_SECONDS;
  const byId = new Map(saved.map(post => [post.id, post]));
  // One second back so posts sharing the newest timestamp are not skipped; ids remove the repeats.
  let after = saved.length ? Math.max(...saved.map(post => post.created_utc)) - 1 : cutoff;
  let added = 0;
  try {
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      if (pages) await sleep(PAUSE_MS);
      const page = await fetchPage(after);
      const before = added;
      for (const post of page) {
        const url = repoLink(post);
        if (!url || byId.has(post.id)) continue;
        byId.set(post.id, {
          id: post.id,
          title: post.title || '',
          url,
          created_utc: post.created_utc,
          num_comments: post.num_comments || 0
        });
        added++;
      }
      // Saved after every page, so a stopped run loses nothing and the next one resumes from here.
      if (added > before) write(byId, cutoff);
      const last = page.length ? new Date(Math.max(...page.map(post => post.created_utc)) * 1000).toISOString() : '-';
      console.log('reddit page', pages + 1, `+${added - before}`, 'up to', last);
      if (page.length < 100) break;
      after = Math.max(...page.map(post => post.created_utc));
    }
  } catch (error) {
    // Keep what this run got; the next run continues from the newest saved post.
    console.error('Error reddit:', error.message);
  }
  if (!added) return console.log('reddit: no new posts');
  console.log('reddit', `+${added}`, `${write(byId, cutoff)} posts kept`);
}

if (require.main === module) updateReddit();

module.exports = {
  updateReddit
}
