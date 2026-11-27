export const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const num = (s) => Number(String(s ?? '').replace(/,/g, '')) || 0;

export function growth(item) {
  const add = num(item.addStars);
  const base = num(item.stars) - add;
  return { add, pct: base > 0 ? (add / base) * 100 : null };
}

// lists: [{ period: 'day' | 'week' | 'month', items: [...] }]
export function mergeTrending(lists) {
  const repos = new Map();
  for (const { period, items } of lists) {
    for (const item of items) {
      const name = item.title?.trim();
      if (!REPO_NAME.test(name ?? '')) continue;
      const key = name.toLowerCase();
      if (!repos.has(key)) {
        repos.set(key, {
          name,
          description: item.description ?? '',
          language: item.language ?? '',
          languageColor: item.languageColor ?? '',
          day: null,
          week: null,
          month: null,
        });
      }
      repos.get(key)[period] ??= growth(item);
    }
  }
  return [...repos.values()];
}

// Applies stars made after the cached star check. Never mutates the cached data.
export function dropRecentStars(data, recentStars) {
  const recent = new Set(recentStars.map((name) => name.toLowerCase()));
  const repos = data.repos.filter((repo) => !recent.has(repo.name.toLowerCase()));
  return { ...data, repos, hiddenStarred: data.hiddenStarred + data.repos.length - repos.length };
}

// nodes[i] is the GraphQL result for repos[i], null when the repo no longer exists.
export function dropStarred(repos, nodes) {
  const seen = new Set();
  const visible = [];
  let hiddenStarred = 0;
  repos.forEach((repo, i) => {
    const node = nodes[i];
    // Renamed repos redirect, so two trending names can resolve to one repo.
    if (!node || seen.has(node.nameWithOwner)) return;
    seen.add(node.nameWithOwner);
    if (node.viewerHasStarred) {
      hiddenStarred++;
      return;
    }
    visible.push({
      ...repo,
      name: node.nameWithOwner,
      // Hacker News entries arrive without these, so GitHub fills them in.
      description: repo.description || node.description || '',
      language: repo.language || node.primaryLanguage?.name || '',
      languageColor: repo.languageColor || node.primaryLanguage?.color || '',
      stars: node.stargazerCount,
      pushedAt: node.pushedAt,
      archived: node.isArchived,
      avatar: node.owner.avatarUrl,
      topics: node.repositoryTopics.nodes.map((n) => n.topic.name),
    });
  });
  return { repos: visible, hiddenStarred };
}

// Hidden-list snapshots come from the browser, so keep only known fields in safe shapes.
export function cleanSnapshot(repo) {
  if (!repo || typeof repo.name !== 'string' || !REPO_NAME.test(repo.name)) return null;
  const period = (g) => (g ? { add: Number(g.add) || 0, pct: Number.isFinite(g.pct) ? g.pct : null } : null);
  const text = (s, max) => String(s ?? '').slice(0, max);
  return {
    name: repo.name,
    description: text(repo.description, 1000),
    language: text(repo.language, 60),
    languageColor: /^#[0-9a-f]{3,8}$/i.test(repo.languageColor) ? repo.languageColor : '',
    day: period(repo.day),
    week: period(repo.week),
    month: period(repo.month),
    stars: Number(repo.stars) || 0,
    pushedAt: Number.isNaN(Date.parse(repo.pushedAt)) ? null : String(repo.pushedAt),
    archived: repo.archived === true,
    avatar: String(repo.avatar ?? '').startsWith('https://avatars.githubusercontent.com/') ? repo.avatar : '',
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 20).map((t) => text(t, 60)) : [],
  };
}

// GitHub paths that are site pages rather than an owner.
const NOT_OWNERS = new Set([
  'about', 'apps', 'collections', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'login',
  'marketplace', 'orgs', 'pricing', 'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending',
]);

export function repoFromUrl(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(String(url ?? ''));
  return m && !NOT_OWNERS.has(m[1].toLowerCase()) ? `${m[1]}/${m[2]}` : null;
}

// Hacker News search hits -> one entry per linked repo, kept from its best-scoring story.
export function hnToRepos(hits) {
  const repos = new Map();
  for (const hit of hits) {
    const name = repoFromUrl(hit.url);
    const id = String(hit.objectID ?? '');
    if (!name || !/^\d+$/.test(id)) continue;
    const key = name.toLowerCase();
    const points = Number(hit.points) || 0;
    if ((repos.get(key)?.hn.points ?? -1) >= points) continue;
    repos.set(key, {
      name,
      description: '',
      language: '',
      languageColor: '',
      day: null,
      week: null,
      month: null,
      hn: {
        id,
        title: String(hit.title ?? ''),
        points,
        comments: Number(hit.num_comments) || 0,
        time: Number(hit.created_at_i) || 0,
      },
    });
  }
  return [...repos.values()];
}

// releasemonitor.org text list, best release first: "* [Name v1.2.3](https://github.com/owner/repo) – description".
// score counts down from the top so a higher score is a better-ranked release.
export function parseReleases(text) {
  const repos = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\* \[(.+?)\]\((https?:\/\/[^)\s]+)\)\s*[–-]\s*(.*)$/.exec(line.trim());
    const name = m && repoFromUrl(m[2]);
    if (!name || repos.has(name.toLowerCase())) continue;
    const cut = m[1].lastIndexOf(' ');
    repos.set(name.toLowerCase(), {
      name,
      description: m[3].trim(),
      language: '',
      languageColor: '',
      day: null,
      week: null,
      month: null,
      release: { title: cut > 0 ? m[1].slice(0, cut) : m[1], version: cut > 0 ? m[1].slice(cut + 1) : '' },
    });
  }
  const list = [...repos.values()];
  list.forEach((repo, i) => (repo.release.score = list.length - i));
  return list;
}

const GITHUB_LINK = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/gi;

// r/BestGitHubRepos posts (Arctic Shift archive) -> one entry per linked repo, from its newest post.
// The repo link sits in the post body more often than in its url, so both are searched.
export function redditToRepos(posts) {
  const repos = new Map();
  for (const post of posts) {
    const id = String(post.id ?? '');
    if (!/^[a-z0-9]+$/i.test(id)) continue;
    const name = [...`${post.url ?? ''} ${post.selftext ?? ''}`.matchAll(GITHUB_LINK)]
      .map((m) => repoFromUrl(m[0].replace(/\.+$/, '')))
      .find(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    const time = Number(post.created_utc) || 0;
    if ((repos.get(key)?.reddit.time ?? -1) >= time) continue;
    repos.set(key, {
      name,
      description: '',
      language: '',
      languageColor: '',
      day: null,
      week: null,
      month: null,
      // Posts saved before other subreddits were collected have no sub; they are all from r/BestGitHubRepos.
      reddit: { id, sub: /^\w{2,21}$/.test(post.sub ?? '') ? post.sub : 'BestGitHubRepos', title: String(post.title ?? ''), time, comments: Number(post.num_comments) || 0 },
    });
  }
  return [...repos.values()];
}

// One entry per repo across sources, keeping each source's details (release, reddit) side by side.
export function mergeSources(...lists) {
  const repos = new Map();
  for (const repo of lists.flat()) {
    const key = repo.name.toLowerCase();
    const prev = repos.get(key);
    repos.set(key, prev
      ? { ...prev, release: prev.release ?? repo.release, reddit: prev.reddit ?? repo.reddit, github: prev.github || repo.github, description: prev.description || repo.description }
      : repo);
  }
  return [...repos.values()];
}

// GitHub search results (repotrend.com's method): new repos, with when they were made and stars per day since.
export function searchToRepos(items, now = Date.now()) {
  return items
    .filter((item) => REPO_NAME.test(item?.full_name ?? ''))
    .map((item) => {
      const time = Math.floor(Date.parse(item.created_at) / 1000) || 0;
      const days = Math.max((now / 1000 - time) / 86400, 1);
      return {
        name: item.full_name,
        description: String(item.description ?? ''),
        language: String(item.language ?? ''),
        languageColor: '',
        day: null,
        week: null,
        month: null,
        created: { time, perDay: Math.round((Number(item.stargazers_count) || 0) / days) },
        // Search already has these, so a list can be shown without the GraphQL lookup.
        stars: Number(item.stargazers_count) || 0,
        pushedAt: item.pushed_at ?? null,
        archived: Boolean(item.archived),
        avatar: String(item.owner?.avatar_url ?? ''),
        topics: Array.isArray(item.topics) ? item.topics.map(String) : [],
      };
    });
}

// data/skills/skills.json entries (collected like AgentSkillsHub) as page rows, without the repos you starred.
export function skillsToRepos(entries, starred, now = Date.now()) {
  const repos = [];
  let hiddenStarred = 0;
  for (const e of entries) {
    if (!REPO_NAME.test(e?.name ?? '')) continue;
    if (starred.has(e.name.toLowerCase())) {
      hiddenStarred++;
      continue;
    }
    const time = Math.floor(Date.parse(e.created) / 1000) || 0;
    const stars = Number(e.stars) || 0;
    repos.push({
      name: e.name,
      description: String(e.description ?? ''),
      language: String(e.language ?? ''),
      languageColor: '',
      day: null,
      week: null,
      month: null,
      stars,
      pushedAt: e.pushed ?? null,
      archived: false,
      // GitHub serves an owner's avatar by login, so the file doesn't store the URL.
      avatar: `https://avatars.githubusercontent.com/${e.name.split('/')[0]}?s=40`,
      topics: Array.isArray(e.topics) ? e.topics.map(String) : [],
      created: { time, perDay: Math.round(stars / Math.max((now / 1000 - time) / 86400, 1)) },
      skill: String(e.type ?? 'tool'),
    });
  }
  return { repos, hiddenStarred };
}

// "github.com/owner/repo" anywhere in text, also broken up by spaces ("github. com / owner / repo").
const LOOSE_GITHUB_LINK = /github\s*\.\s*com\s*\/\s*([A-Za-z0-9][A-Za-z0-9-]{0,38})\s*\/\s*([A-Za-z0-9._-]{1,100})/gi;
// A bare "owner/repo" that is not part of a URL or path: nothing word-like, "/", ".", ":" or "@" right before it,
// and no further "/" after it.
const BARE_REPO = /(?<![\w./:@#-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?![\w/-])/g;
// Common "x/y" phrases that look like owner/repo. Real repos with these names exist, so they are refused outright.
const NOT_REPOS = new Set([
  'and/or', 'ai/ml', 'ci/cd', 'client/server', 'input/output', 'tcp/ip', 'i/o', 'read/write', 'true/false', 'yes/no',
  'on/off', 'w/o', 'b/c', 'he/she', 'his/her', 'him/her', 'they/them', 'she/her', 'he/him', 'pros/cons', 'win/win',
  'front/back', 'frontend/backend', 'dev/prod', 'macos/linux', 'linux/macos', 'windows/linux', 'ios/android',
  'android/ios', 'text/image', 'image/video', 'text/html', 'application/json', 'q/a', 'p/s', 'per/day', 'n/a',
]);
// Trailing dots first ("repo.git." at a sentence end), then ".git".
const cleanRepo = (repo) => repo.replace(/[.]+$/, '').replace(/\.git$/i, '');

// Repos named in a piece of text, each once: {name, bare} where bare means it was only written as "owner/repo".
export function reposInText(text) {
  const found = new Map();
  const s = String(text ?? '');
  for (const m of s.matchAll(LOOSE_GITHUB_LINK)) {
    const repo = cleanRepo(m[2]);
    if (repo && !NOT_OWNERS.has(m[1].toLowerCase())) found.set(`${m[1]}/${repo}`.toLowerCase(), { name: `${m[1]}/${repo}`, bare: false });
  }
  // URLs are cut out first so their paths (x.com/user/status, t.co/abc) can't pass as owner/repo.
  for (const m of s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(LOOSE_GITHUB_LINK, ' ').matchAll(BARE_REPO)) {
    const repo = cleanRepo(m[2]);
    const name = `${m[1]}/${repo}`;
    const key = name.toLowerCase();
    if (!repo || found.has(key) || NOT_REPOS.has(key) || NOT_OWNERS.has(m[1].toLowerCase())) continue;
    // Dates, scores and fractions: 24/7, 11/20, 3/4.
    if (/^\d+$/.test(m[1]) || /^\d+$/.test(repo)) continue;
    found.set(key, { name, bare: true });
  }
  return [...found.values()];
}

// Collected tweets (data/twitter/tweets.json) -> one row per repo, from the newest post that names it.
// A reply by the author under their own post counts for that post, since links are often put in the first reply.
export function tweetsToRepos(tweets, since = 0) {
  const byId = new Map(tweets.map((t) => [t.id, t]));
  const repos = new Map();
  for (const t of tweets) {
    if (!(t.time >= since)) continue;
    const post = (t.conv && byId.get(t.conv)) || t;
    const postId = t.conv || t.id;
    for (const { name, bare } of reposInText(`${t.text} ${(t.urls ?? []).join(' ')}`)) {
      if (!REPO_NAME.test(name)) continue;
      const key = name.toLowerCase();
      const prev = repos.get(key);
      const tweet = {
        id: String(postId),
        user: String(post.user ?? t.user),
        text: String(post.text ?? t.text),
        time: Number(post.time ?? t.time) || 0,
        likes: Number(post.likes ?? t.likes) || 0,
      };
      // bare stays true only while no post linked the repo in full.
      if (!prev) repos.set(key, { name, description: '', language: '', languageColor: '', day: null, week: null, month: null, tweet, bare });
      else repos.set(key, { ...prev, bare: prev.bare && bare, tweet: tweet.time > prev.tweet.time ? tweet : prev.tweet });
    }
  }
  return [...repos.values()];
}

// Page rows (from hnToRepos or redditToRepos) with each repo's saved GitHub details (data/hn/repos.json,
// data/reddit/repos.json). Repos GitHub no longer has are left out, a renamed repo linked under both names appears
// once (`better(a, b)` says whether row a beats row b), and rows whose repo hasn't been looked up yet are returned
// apart in `unknown`.
export function withDetails(rows, details, better) {
  const best = new Map();
  const unknown = [];
  for (const row of rows) {
    const d = details[row.name.toLowerCase()];
    if (!d) {
      unknown.push(row);
      continue;
    }
    if (d.missing || !REPO_NAME.test(d.name ?? '')) continue;
    const key = d.name.toLowerCase();
    const prev = best.get(key);
    if (prev && !better(row, prev)) continue;
    best.set(key, {
      ...row,
      name: d.name,
      description: String(d.description ?? ''),
      language: String(d.language ?? ''),
      languageColor: String(d.languageColor ?? ''),
      stars: Number(d.stars) || 0,
      pushedAt: d.pushedAt ?? null,
      archived: Boolean(d.archived),
      avatar: `https://avatars.githubusercontent.com/${d.name.split('/')[0]}?s=40`,
      topics: Array.isArray(d.topics) ? d.topics.map(String) : [],
    });
  }
  return { repos: [...best.values()], unknown };
}

// Collected HN stories (data/hn) as page rows, one per repo from its best story. The HN collector looks every repo
// up, so a repo without details is one GitHub doesn't have and is left out.
export function hnWithDetails(stories, details) {
  return withDetails(hnToRepos(stories), details, (a, b) => a.hn.points > b.hn.points).repos;
}
