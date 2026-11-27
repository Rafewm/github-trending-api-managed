const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')
const { updateRepos } = require('./hn')

// Reddit posts that link a GitHub repo, from the Arctic Shift Reddit archive
// (https://github.com/ArthurHeitmann/arctic_shift/tree/master/api), from r/BestGitHubRepos and the subreddits below.
//
// - data/reddit/BestGitHubRepos.json (it kept its first name): new posts, read forward from where each subreddit was
//   last read. Each post has `sub`; `checked` is the newest post time read per subreddit; `subs` lists them all.
// - data/reddit/history/<sub>.json: each subreddit's year before it was added, written only by
//   script/reddit_history.js (a separate, resumable workflow), so the two never write the same file.
// - data/reddit/repos.json: each linked repo's GitHub details, looked up once and re-checked in rotation (the same
//   way as data/hn/repos.json), so the site never has to look tens of thousands of repos up itself.
//
// Every post is read: the archive's text and url searches time out and returned nothing in tests.
const API = 'https://arctic-shift.photon-reddit.com/api/posts/search?fields=id,title,url,selftext,num_comments,created_utc&limit=100';
const FULL = 'BestGitHubRepos';
const SUBREDDITS = [
  FULL,
  // Open source and tools
  'coolgithubprojects', 'opensource', 'OpenSourceAI', 'OpenSourceeAI', 'opensourcealternative', 'opensourcez',
  'TrueOpenSource', 'foss', 'freesoftware', 'flossdroid', 'software', 'alternativeto', 'selfhosted', 'SelfHosting',
  'DataHoarder', 'homeassistant', 'devops',
  // AI and agents
  'LocalLLaMA', 'LLMDevs', 'MachineLearning', 'learnmachinelearning', 'artificial', 'ArtificialInteligence', 'AI_Agents',
  'aiagents', 'AgentsOfAI', 'BuildingWithAgents', 'Agentic_SEO', 'OpenSignups',
  // Claude and coding
  'claude', 'ClaudeAI', 'ClaudeCode', 'ClaudeCoder', 'ClaudeCoding', 'claudeskills', 'ChatGPT', 'vibecoding', 'WebAfterAI',
  // Side projects
  'SideProject', 'sideprojects', 'ShowYourApp', 'buildinpublic', 'IMadeThis', 'projects',
  // Graphics and decompilation
  'threejs', 'decomps', 'recomps', 'blender'
];
const DIR = path.resolve(__dirname, DATA_BASE_URL, 'reddit');
const FILE = path.join(DIR, 'BestGitHubRepos.json');
const REPOS = path.join(DIR, 'repos.json');
const HISTORY = path.join(DIR, 'history');
const KEEP_SECONDS = 365 * 86400;
// The archive sometimes saves a post hours after newer ones, so each read starts this far before the last one.
const REFETCH_SECONDS = 2 * 86400;
// A subreddit read here for the first time starts this far back; reddit_history.js fills in the year before it.
const FIRST_READ_SECONDS = 2 * 86400;
// The archive allows about one request every few seconds. A run stops after RUN_MS and the next one continues with
// the subreddits read longest ago.
const PAUSE_MS = 3000;
const RUN_MS = Number(process.env.REDDIT_RUN_MINUTES || 20) * 60 * 1000;
const GITHUB_LINK = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/gi;
// GitHub paths that are site pages rather than an owner.
const NOT_OWNERS = new Set([
  'about', 'apps', 'collections', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'login',
  'marketplace', 'orgs', 'pricing', 'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One page of a subreddit's posts. `params` picks the direction: after=<t>&sort=asc or before=<t>&sort=desc.
async function fetchPage (sub, params, attempt = 1) {
  const res = await fetch(`${API}&subreddit=${sub}&${params}`, { headers: { 'User-Agent': 'github-trending-api' } }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if ((!res || res.status === 422 || res.status === 429 || res.status >= 500 || body.error) && attempt < 8) {
    await sleep(Math.max(Number(res?.headers.get('x-ratelimit-reset')) || 0, 5 * attempt) * 1000);
    return fetchPage(sub, params, attempt + 1);
  }
  if (!res?.ok || body.error) throw new Error(`Arctic Shift: ${body.error || res?.status || 'no response'}`);
  return body.data || [];
}

// First owner/repo link in the post's url or body, or null.
function repoLink (post) {
  for (const m of `${post.url || ''} ${post.selftext || ''}`.matchAll(GITHUB_LINK)) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '').replace(/\.+$/, '');
    if (repo && repo !== '.' && !NOT_OWNERS.has(owner.toLowerCase())) return `https://github.com/${owner}/${repo}`;
  }
  return null;
}

// The saved shape of a post that links a repo, or null.
function toEntry (post, sub) {
  const url = repoLink(post);
  if (!url) return null;
  return { id: post.id, sub, title: String(post.title || '').slice(0, 300), url, created_utc: post.created_utc, num_comments: post.num_comments || 0 };
}

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

function write (byId, checked, cutoff) {
  const posts = [...byId.values()]
    .filter(post => post.created_utc >= cutoff)
    .sort((a, b) => b.created_utc - a.created_utc);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), subs: SUBREDDITS, checked, posts }), 'utf-8');
  return posts.length;
}

async function readNewPosts () {
  const file = readJson(FILE, {});
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - KEEP_SECONDS;
  // Posts saved before other subreddits were added have no `sub`; they all came from r/BestGitHubRepos.
  const byId = new Map((file.posts || []).map(post => [post.id, { sub: FULL, ...post }]));
  const checked = { ...file.checked };
  if (!checked[FULL] && byId.size) checked[FULL] = Math.max(...[...byId.values()].map(post => post.created_utc));
  const started = Date.now();
  let added = 0;
  const order = [...SUBREDDITS].sort((a, b) => (checked[a] || 0) - (checked[b] || 0));
  for (const sub of order) {
    if (Date.now() - started > RUN_MS) {
      console.log('reddit: time is up, the rest wait for the next run');
      break;
    }
    let after = checked[sub] ? Math.max(checked[sub] - REFETCH_SECONDS, cutoff) : now - FIRST_READ_SECONDS;
    let subAdded = 0;
    try {
      for (let pages = 0; ; pages++) {
        await sleep(PAUSE_MS);
        const page = await fetchPage(sub, `after=${after}&sort=asc`);
        for (const post of page) {
          const entry = byId.has(post.id) ? null : toEntry(post, sub);
          if (entry) {
            byId.set(post.id, entry);
            subAdded++;
          }
        }
        if (page.length) checked[sub] = Math.max(checked[sub] || 0, ...page.map(post => post.created_utc));
        // Saved after every page, so a run cut short resumes from here.
        write(byId, checked, cutoff);
        if (page.length < 100 || Date.now() - started > RUN_MS) break;
        after = Math.max(...page.map(post => post.created_utc));
      }
    } catch (error) {
      console.error(`Error reddit r/${sub}:`, error.message);
    }
    if (!checked[sub]) checked[sub] = now - FIRST_READ_SECONDS;
    added += subAdded;
    console.log(`reddit r/${sub}: +${subAdded}`);
  }
  console.log('reddit', `+${added}`, `${write(byId, checked, cutoff)} posts kept`);
  return [...byId.values()];
}

// Every post in the history files, which reddit_history.js writes.
function historyPosts () {
  if (!existsSync(HISTORY)) return [];
  return SUBREDDITS.flatMap(sub => readJson(path.join(HISTORY, `${sub}.json`), { posts: [] }).posts);
}

async function updateReddit () {
  const posts = await readNewPosts();
  // Repo details for every linked repo, new and backfilled. updateRepos (from hn.js) looks new ones up and re-checks
  // the rest in rotation; it stops at the first GraphQL failure and keeps what it has, so a large first fill spreads
  // over several runs.
  const linked = [...posts, ...historyPosts()]
    .map(post => ({ repo: post.url.replace('https://github.com/', ''), created_at_i: post.created_utc }));
  const repos = await updateRepos(linked, readJson(REPOS, { repos: {} }).repos);
  writeFileSync(REPOS, JSON.stringify({ updated: new Date().toISOString(), repos }), 'utf-8');
  console.log('reddit repos:', Object.keys(repos).length, 'with details');
}

if (require.main === module) updateReddit();

module.exports = {
  updateReddit,
  SUBREDDITS,
  FULL,
  fetchPage,
  toEntry,
  KEEP_SECONDS,
  HISTORY,
  PAUSE_MS
}
