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
