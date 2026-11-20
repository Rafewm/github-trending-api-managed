const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Recent posts from the X accounts in data/twitter/accounts.json that may name a GitHub repo, from twitterapi.io
// (https://docs.twitterapi.io). Saved to data/twitter/tweets.json; the site finds the repos in them.
// The author's own replies under their posts are kept too, since links are often put in the first reply.
const API = 'https://api.twitterapi.io/twitter/user/last_tweets';
const DIR = path.resolve(__dirname, DATA_BASE_URL, 'twitter');
const ACCOUNTS = path.join(DIR, 'accounts.json');
const FILE = path.join(DIR, 'tweets.json');
const KEEP_SECONDS = 365 * 86400;
// twitterapi.io bills $0.15 per 1,000 tweets returned, so one run of 47 accounts is about $0.14. The Action runs every
// 4 hours; this makes every third run fetch. Lower it to fetch more often.
const EVERY_MS = 11.5 * 60 * 60 * 1000;
// Pages per account per run (20 tweets each). Paging stops earlier at the first tweet already saved.
const MAX_PAGES = 3;
// The free tier allows one request every 5 seconds.
const PAUSE_MS = 5500;
// A loose test; the site does the strict one, so a better parser later still works on saved tweets.
const MAYBE_REPO = /(?<![\w./:@#-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchPage (user, cursor, attempt = 1) {
  const url = `${API}?userName=${encodeURIComponent(user)}&includeReplies=true&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url, { headers: { 'X-API-Key': process.env.TWITTERAPI_KEY } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 429 && attempt < 4) {
    await sleep(PAUSE_MS * attempt * 2);
    return fetchPage(user, cursor, attempt + 1);
  }
  if (!res.ok || body.status === 'error') throw new Error(`twitterapi.io ${res.status}: ${body.msg || body.message || ''}`);
  return body;
}

// Text and expanded links to search, including a reposted or quoted post (repost text is cut short).
function content (t) {
  const inner = t.retweeted_tweet || t.quoted_tweet;
  const urls = [t, inner].filter(Boolean).flatMap(x => (x.entities && x.entities.urls || []).map(u => u.expanded_url).filter(Boolean));
  const text = t.retweeted_tweet ? t.retweeted_tweet.text : `${t.text || ''}${t.quoted_tweet ? ` ${t.quoted_tweet.text || ''}` : ''}`;
  return { text: text || '', urls };
}

function toEntry (t, user) {
  const { text, urls } = content(t);
  const self = t.isReply && String(t.inReplyToUsername || '').toLowerCase() === user.toLowerCase();
  return {
    id: String(t.id),
    user: (t.author && t.author.userName) || user,
    time: Math.floor(Date.parse(t.createdAt) / 1000) || 0,
    text,
    urls,
    likes: t.likeCount || 0,
    ...(self && t.conversationId && t.conversationId !== t.id ? { conv: String(t.conversationId) } : {}),
    ...(t.retweeted_tweet ? { rt: (t.retweeted_tweet.author && t.retweeted_tweet.author.userName) || '' } : {})
  };
}

// "github" anywhere (links, spaced links), or an owner/repo shape in the text once links are cut out: any link
// path ("site.com/page") would otherwise look like one.
const maybeRepo = entry => /github/i.test(`${entry.text} ${entry.urls.join(' ')}`) ||
  MAYBE_REPO.test(entry.text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' '));

// readUntil: per account, the newest post time already read, so the next run stops paging there.
function write (byId, readUntil, cutoff, updated) {
  const tweets = [...byId.values()].filter(t => t.time >= cutoff).sort((a, b) => b.time - a.time);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ updated, readUntil, tweets }), 'utf-8');
  return tweets.length;
}

async function updateTwitter () {
  try {
    if (!process.env.TWITTERAPI_KEY) return console.log('twitter: TWITTERAPI_KEY is not set, skipped');
    const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { tweets: [] };
    if (saved.updated && Date.now() - Date.parse(saved.updated) < EVERY_MS) return console.log('twitter: updated recently, skipped');
    const accounts = JSON.parse(readFileSync(ACCOUNTS, 'utf8'));
    const cutoff = Math.floor(Date.now() / 1000) - KEEP_SECONDS;
    const byId = new Map(saved.tweets.map(t => [t.id, t]));
    const readUntil = saved.readUntil || {};
    // Kept on the old value until the run ends, so an interrupted run is retried next time instead of skipped.
    const updated = saved.updated || new Date(0).toISOString();
    let added = 0;
    let requests = 0;
    for (const user of accounts) {
      try {
        const until = readUntil[user] || 0;
        const read = [];
        let cursor = '';
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (requests++) await sleep(PAUSE_MS);
          const body = await fetchPage(user, cursor);
          const tweets = ((body.data && body.data.tweets) || [])
            // Replies to other people are mostly chat; only the author's own threads are read.
            .filter(t => !t.isReply || String(t.inReplyToUsername || '').toLowerCase() === user.toLowerCase())
            .map(t => toEntry(t, user));
          read.push(...tweets);
          // Pinned posts can be old, so a page stops paging only when its newest post was already read.
          if (!tweets.length || Math.max(...tweets.map(t => t.time)) <= until) break;
          if (!body.has_next_page || !body.next_cursor) break;
          cursor = body.next_cursor;
        }
        const pool = new Map(read.map(t => [t.id, t]));
        for (const t of read) {
          if (byId.has(t.id) || !maybeRepo(t)) continue;
          byId.set(t.id, t);
          added++;
          // The post a self-reply answers is kept too: its text is what the page shows.
          const root = t.conv && pool.get(t.conv);
          if (root && !byId.has(root.id)) byId.set(root.id, root);
        }
        if (read.length) readUntil[user] = Math.max(until, ...read.map(t => t.time));
        // Saved after every account, so a stopped run keeps what it paid for.
        write(byId, readUntil, cutoff, updated);
        console.log('twitter', user, `read ${read.length}`, `kept ${byId.size}`);
      } catch (error) {
        console.error('Error twitter', user, error.message);
      }
    }
    console.log('twitter', `+${added}`, `${write(byId, readUntil, cutoff, new Date().toISOString())} posts kept`, `${requests} requests`);
  } catch (error) {
    // Never fail the trending build over this step.
    console.error('Error twitter:', error.message);
  }
}

if (require.main === module) updateTwitter();

module.exports = {
  updateTwitter
}
