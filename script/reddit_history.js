const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { SUBREDDITS, FULL, fetchPage, toEntry, KEEP_SECONDS, HISTORY, PAUSE_MS } = require('./reddit')

// One-time backfill of each subreddit's last year, run by .github/workflows/reddit_history.yml until done.
// Writes only data/reddit/history/<sub>.json (script/reddit.js reads new posts into another file, so the two runs
// never write the same file). Each file: {start, oldest, done, posts}: posts from `start` (when the backfill began)
// back to `oldest`. It reads newest first and always continues the subreddit with the least history, so every
// subreddit gets its last day, then week, then month before any gets its year. Saves after every page.
// r/BestGitHubRepos already has its year in the main file.
const RUN_MS = Number(process.env.REDDIT_RUN_MINUTES || 300) * 60 * 1000;
// The workflow runs SHARDS jobs at once (each on its own runner, so the archive's per-address limit applies to each);
// job SHARD takes every SHARDS-th subreddit, and the jobs never write the same file.
const SHARDS = Number(process.env.SHARDS || 1);
const SHARD = Number(process.env.SHARD || 0);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileOf = sub => path.join(HISTORY, `${sub}.json`);

function load (sub, now) {
  if (existsSync(fileOf(sub))) return JSON.parse(readFileSync(fileOf(sub), 'utf8'));
  return { start: now, oldest: now, done: false, posts: [] };
}

function save (sub, state) {
  mkdirSync(HISTORY, { recursive: true });
  writeFileSync(fileOf(sub), JSON.stringify(state), 'utf-8');
}

async function backfill () {
  const now = Math.floor(Date.now() / 1000);
  const started = Date.now();
  const mine = SUBREDDITS.filter(sub => sub !== FULL).filter((_, i) => i % SHARDS === SHARD);
  const states = Object.fromEntries(mine.map(sub => [sub, load(sub, now)]));
  let pages = 0;
  const failing = new Set();
  while (Date.now() - started < RUN_MS) {
    // The subreddit whose history reaches least far back goes next.
    const open = Object.entries(states).filter(([sub, s]) => !s.done && !failing.has(sub)).sort((a, b) => b[1].oldest - a[1].oldest);
    if (!open.length) break;
    const [sub, state] = open[0];
    const cutoff = state.start - KEEP_SECONDS;
    await sleep(PAUSE_MS);
    let page;
    try {
      // One second past the oldest read, so posts sharing that second aren't skipped; ids remove the repeats.
      page = await fetchPage(sub, `before=${state.oldest + 1}&sort=desc`);
    } catch (error) {
      // fetchPage already retried; leave this subreddit for the next run so the others keep moving.
      console.error(`Error history r/${sub}:`, error.message);
      failing.add(sub);
      continue;
    }
    const seen = new Set(state.posts.map(post => post.id));
    for (const post of page) {
      const entry = post.created_utc >= cutoff && !seen.has(post.id) ? toEntry(post, sub) : null;
      if (entry) state.posts.push(entry);
    }
    if (page.length) state.oldest = Math.min(...page.map(post => post.created_utc));
    if (page.length < 100 || state.oldest <= cutoff) state.done = true;
    save(sub, state);
    pages++;
    if (pages % 20 === 0 || state.done) {
      const days = Math.round((state.start - state.oldest) / 86400);
      console.log(`history r/${sub}: ${days} days back, ${state.posts.length} repo posts${state.done ? ', done' : ''}`);
    }
  }
  const left = Object.entries(states).filter(([, s]) => !s.done);
  const reach = left.length ? Math.round((now - Math.max(...left.map(([, s]) => s.oldest))) / 86400) : 365;
  console.log(`history shard ${SHARD + 1}/${SHARDS}: ${pages} pages this run; ${left.length} of ${mine.length} subreddits not done; all reach at least ${reach} days back`);
  if (!left.length) console.log(`history shard ${SHARD + 1}/${SHARDS}: every subreddit has its year`);
}

if (require.main === module) backfill();

module.exports = {
  backfill
}
