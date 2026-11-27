import test from 'node:test';
import assert from 'node:assert/strict';
import { growth, mergeTrending, dropStarred, dropRecentStars } from './trending.js';
import { searchToRepos, skillsToRepos, hnWithDetails } from './trending.js';

const item = (title, stars, addStars) => ({ title, stars, addStars, description: 'd', language: 'Go' });
const node = (nameWithOwner, viewerHasStarred) => ({
  nameWithOwner,
  viewerHasStarred,
  stargazerCount: 10,
  pushedAt: '2026-11-01T00:00:00Z',
  isArchived: false,
  owner: { avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
  repositoryTopics: { nodes: [{ topic: { name: 'cli' } }] },
});

test('growth is relative to stars before the period', () => {
  assert.deepEqual(growth(item('a/b', '1,500', '500')), { add: 500, pct: 50 });
});

test('growth has no percent for a repo that gained all its stars in the period', () => {
  assert.deepEqual(growth(item('a/b', '500', '500')), { add: 500, pct: null });
});

test('mergeTrending joins periods case-insensitively and rejects bad names', () => {
  const repos = mergeTrending([
    { period: 'day', items: [item('a/b', '110', '10'), item('not a repo', '1', '1')] },
    { period: 'week', items: [item('A/B', '120', '20')] },
  ]);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].day.add, 10);
  assert.equal(repos[0].week.add, 20);
  assert.equal(repos[0].month, null);
});

test('dropRecentStars hides new stars case-insensitively and keeps the cache intact', () => {
  const cached = { repos: [{ name: 'a/x' }, { name: 'a/y' }], hiddenStarred: 5, tracked: 7 };
  const out = dropRecentStars(cached, ['A/X', 'other/repo']);
  assert.deepEqual(out.repos, [{ name: 'a/y' }]);
  assert.equal(out.hiddenStarred, 6);
  assert.equal(out.tracked, 7);
  assert.equal(cached.repos.length, 2);
  assert.equal(cached.hiddenStarred, 5);
});

test('dropStarred removes starred, deleted and redirected duplicate repos', () => {
  const repos = mergeTrending([{ period: 'day', items: ['a/x', 'a/y', 'a/z', 'a/old'].map((n) => item(n, '2', '1')) }]);
  const out = dropStarred(repos, [node('a/x', true), node('a/y', false), null, node('a/y', false)]);
  assert.deepEqual(out.repos.map((r) => r.name), ['a/y']);
  assert.equal(out.hiddenStarred, 1);
  assert.deepEqual(out.repos[0].topics, ['cli']);
});

test('repoFromUrl keeps owner/repo links only', async () => {
  const { repoFromUrl } = await import('./trending.js');
  assert.equal(repoFromUrl('https://github.com/a/b'), 'a/b');
  assert.equal(repoFromUrl('https://www.github.com/a/b.js/tree/main?x=1'), 'a/b.js');
  assert.equal(repoFromUrl('https://github.com/a/b.git'), 'a/b');
  assert.equal(repoFromUrl('https://github.com/a'), null);
  assert.equal(repoFromUrl('https://github.com/sponsors/a'), null);
  assert.equal(repoFromUrl('https://gist.github.com/a/123'), null);
  assert.equal(repoFromUrl('https://evil.com/?github.com/a/b'), null);
});

test('hnToRepos keeps each repo once, from its best story', async () => {
  const { hnToRepos } = await import('./trending.js');
  const hit = (objectID, url, points) => ({ objectID, url, points, title: `t${objectID}`, num_comments: 3, created_at_i: 100 });
  const repos = hnToRepos([hit('1', 'https://github.com/a/b', 10), hit('2', 'https://github.com/A/B/issues', 50), hit('3', 'https://github.com/c/d', 5), hit('x', 'https://github.com/e/f', 9)]);
  assert.deepEqual(repos.map((r) => [r.name, r.hn.id, r.hn.points]), [['A/B', '2', 50], ['c/d', '3', 5]]);
});

test('dropStarred fills description and language from GitHub when missing', () => {
  const [repo] = dropStarred([{ name: 'a/b', description: '', language: '', languageColor: '' }], [
    { ...node('a/b', false), description: 'from github', primaryLanguage: { name: 'Rust', color: '#dea584' } },
  ]).repos;
  assert.deepEqual([repo.description, repo.language, repo.languageColor], ['from github', 'Rust', '#dea584']);
});

test('parseReleases reads name, version, repo and rank, skipping bad and repeated lines', async () => {
  const { parseReleases } = await import('./trending.js');
  const text = [
    '* [Super Productivity v20.0.0](https://github.com/super-productivity/super-productivity) – Todo app.',
    '',
    '* [Nx 24.0.0](https://github.com/nrwl/nx) – Build system.',
    '* [Not a repo 1.0](https://example.com/x/y) – Skip me.',
    '* [Nx again 24.0.1](https://github.com/nrwl/nx) – Repeat.',
    'garbage line',
  ].join('\n');
  const repos = parseReleases(text);
  assert.deepEqual(
    repos.map((r) => [r.name, r.release.title, r.release.version, r.release.score, r.description]),
    [
      ['super-productivity/super-productivity', 'Super Productivity', 'v20.0.0', 2, 'Todo app.'],
      ['nrwl/nx', 'Nx', '24.0.0', 1, 'Build system.'],
    ],
  );
});

test('redditToRepos finds the repo in the post body and keeps the newest post per repo', async () => {
  const { redditToRepos } = await import('./trending.js');
  const post = (id, created_utc, selftext, url = 'https://i.redd.it/x.png') => ({ id, title: `t${id}`, url, selftext, created_utc, num_comments: 2 });
  const repos = redditToRepos([
    post('a1', 100, '# Repository\n\n[https://github.com/xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire)'),
    post('a2', 200, 'See https://github.com/XBTLIN/ai-berkshire.'),
    post('b1', 150, 'no link here'),
    post('c1', 120, '', 'https://github.com/c/d'),
    post('../x', 130, 'https://github.com/e/f'),
    post('d1', 140, 'https://github.com/sponsors/someone and then https://github.com/g/h'),
  ]);
  assert.deepEqual(repos.map((r) => [r.name, r.reddit.id, r.reddit.time]), [
    ['XBTLIN/ai-berkshire', 'a2', 200],
    ['c/d', 'c1', 120],
    ['g/h', 'd1', 140],
  ]);
});

test('mergeSources joins the same repo from every source into one entry', async () => {
  const { mergeSources } = await import('./trending.js');
  const out = mergeSources(
    [{ name: 'a/b', description: 'from monitor', release: { version: 'v1' } }],
    [{ name: 'A/B', description: '', reddit: { id: 'x' } }, { name: 'c/d', description: '', reddit: { id: 'y' } }],
    [{ name: 'a/b', description: '', github: true }, { name: 'e/f', description: 'popular', github: true }],
  );
  assert.deepEqual(out, [
    { name: 'a/b', description: 'from monitor', release: { version: 'v1' }, reddit: { id: 'x' }, github: true },
    { name: 'c/d', description: '', reddit: { id: 'y' } },
    { name: 'e/f', description: 'popular', github: true },
  ]);
});

test('searchToRepos keeps valid names and works out stars per day', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const repos = searchToRepos(
    [
      { full_name: 'a/b', description: null, language: 'Go', stargazers_count: 1000, created_at: '2026-11-01T00:00:00Z' },
      { full_name: 'a/new', stargazers_count: 60, created_at: '2026-11-10T20:00:00Z' },
      { full_name: 'not a repo', stargazers_count: 5, created_at: '2026-11-01T00:00:00Z' },
    ],
    now,
  );
  assert.deepEqual(repos.map((r) => r.name), ['a/b', 'a/new']);
  assert.equal(repos[0].description, '');
  assert.equal(repos[0].stars, 1000);
  assert.deepEqual(repos[0].topics, []);
  assert.equal(repos[0].created.perDay, 100);
  // Under a day old counts as one day, so a few hours' stars don't look huge.
  assert.equal(repos[1].created.perDay, 60);
});

test('skillsToRepos drops starred repos and bad names, and fills page fields', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const entries = [
    { name: 'a/mcp', stars: 500, created: '2026-11-01T00:00:00Z', pushed: '2026-11-10T00:00:00Z', type: 'mcp', topics: ['mcp'] },
    { name: 'B/Starred', stars: 9, created: '2026-01-01T00:00:00Z', type: 'skill' },
    { name: 'not a repo', stars: 1 },
  ];
  const { repos, hiddenStarred } = skillsToRepos(entries, new Set(['b/starred']), now);
  assert.equal(hiddenStarred, 1);
  assert.deepEqual(repos.map((r) => r.name), ['a/mcp']);
  assert.equal(repos[0].skill, 'mcp');
  assert.equal(repos[0].created.perDay, 50);
  assert.equal(repos[0].pushedAt, '2026-11-10T00:00:00Z');
  assert.equal(repos[0].avatar, 'https://avatars.githubusercontent.com/a?s=40');
});

test('reposInText finds full, spaced and bare repo names, and skips look-alikes', async () => {
  const { reposInText } = await import('./trending.js');
  const names = (text) => reposInText(text).map((r) => `${r.name}${r.bare ? ' (bare)' : ''}`);
  assert.deepEqual(names('Repo: https://github.com/ruvnet/metaharness.git.'), ['ruvnet/metaharness']);
  assert.deepEqual(names('check https://github. com/ruvnet/metaharness now'), ['ruvnet/metaharness']);
  assert.deepEqual(names('github .com / ruvnet / metaharness'), ['ruvnet/metaharness']);
  assert.deepEqual(names('Star it 👉 ruvnet/metaharness!'), ['ruvnet/metaharness (bare)']);
  assert.deepEqual(names('repo (ruvnet/meta-harness_v2.0).'), ['ruvnet/meta-harness_v2.0 (bare)']);
  // The same repo linked and written bare is one entry, not bare.
  assert.deepEqual(names('ruvnet/metaharness → github.com/ruvnet/metaharness'), ['ruvnet/metaharness']);
  // Not repos: phrases, dates, other sites' paths, site pages, mentions and hashtags.
  for (const text of [
    'use and/or 24/7 CI/CD AI/ML client/server on 11/20',
    'https://x.com/tom_doerr/status/123 https://t.co/A3C6kKFL2p huggingface.co/meta/llama',
    'see src/index.js? no: https://github.com/topics/agents and github.com/features/copilot',
    '@user/thing #tag/other',
  ]) assert.deepEqual(names(text).filter((n) => !n.startsWith('src/')), [], text);
});

test('tweetsToRepos credits a self-reply link to its post and keeps the newest post per repo', async () => {
  const { tweetsToRepos } = await import('./trending.js');
  const repos = tweetsToRepos([
    { id: '1', user: 'a', text: 'Great tool for agents', time: 100, likes: 50 },
    { id: '2', user: 'a', conv: '1', text: 'GitHub: https://t.co/x', urls: ['https://github.com/o/tool'], time: 101, likes: 1 },
    { id: '3', user: 'b', text: 'also o/tool is nice', time: 200, likes: 9 },
    { id: '4', user: 'c', text: 'old one/two', time: 5, likes: 0 },
  ], 50);
  assert.deepEqual(repos.map((r) => [r.name, r.bare, r.tweet.id, r.tweet.user, r.tweet.text]), [
    ['o/tool', false, '3', 'b', 'also o/tool is nice'],
  ]);
  const older = tweetsToRepos([
    { id: '1', user: 'a', text: 'Great tool for agents', time: 100, likes: 50 },
    { id: '2', user: 'a', conv: '1', text: 'GitHub: https://t.co/x', urls: ['https://github.com/o/tool'], time: 101, likes: 1 },
  ]);
  assert.deepEqual([older[0].tweet.id, older[0].tweet.text, older[0].tweet.likes], ['1', 'Great tool for agents', 50]);
});

test('hnWithDetails keeps every collected story repo with its details, once per repo', () => {
  const story = (id, url, points) => ({ objectID: id, title: `t${id}`, url, points, num_comments: 1, created_at_i: 1 });
  const stories = [
    story('1', 'https://github.com/lopopolo/harness-engineering/blob/v1.0.0/evals/x.md', 4),
    story('2', 'https://github.com/old/name', 50),
    story('3', 'https://github.com/new/name', 20),
    story('4', 'https://github.com/gone/repo', 9),
  ];
  const details = {
    'lopopolo/harness-engineering': { name: 'lopopolo/harness-engineering', description: 'd', stars: 12, topics: ['ai'] },
    'old/name': { name: 'new/name', stars: 5 },
    'new/name': { name: 'new/name', stars: 5 },
    'gone/repo': { missing: true },
  };
  const rows = hnWithDetails(stories, details);
  assert.deepEqual(rows.map((r) => `${r.name} ${r.hn.points}`).sort(), ['lopopolo/harness-engineering 4', 'new/name 50']);
  const h = rows.find((r) => r.name === 'lopopolo/harness-engineering');
  assert.equal(h.stars, 12);
  assert.equal(h.hn.id, '1');
  assert.equal(h.avatar, 'https://avatars.githubusercontent.com/lopopolo?s=40');
});

test('redditToRepos keeps each post subreddit, defaulting old posts to BestGitHubRepos', async () => {
  const { redditToRepos } = await import('./trending.js');
  const repos = redditToRepos([
    { id: 'a1', sub: 'LocalLLaMA', title: 't', url: 'https://github.com/a/b', created_utc: 1 },
    { id: 'b1', title: 't', url: 'https://github.com/c/d', created_utc: 1 },
    { id: 'c1', sub: '../evil', title: 't', url: 'https://github.com/e/f', created_utc: 1 },
  ]);
  assert.deepEqual(repos.map((r) => [r.name, r.reddit.sub]), [['a/b', 'LocalLLaMA'], ['c/d', 'BestGitHubRepos'], ['e/f', 'BestGitHubRepos']]);
});

test('withDetails joins saved details, keeps the better row per repo and returns repos not looked up apart', async () => {
  const { withDetails } = await import('./trending.js');
  const row = (name, time) => ({ name, reddit: { id: name + time, time } });
  const details = { 'a/b': { name: 'a/b', stars: 5 }, 'old/name': { name: 'new/name', stars: 9 }, 'new/name': { name: 'new/name', stars: 9 }, 'gone/x': { missing: true } };
  const { repos, unknown } = withDetails([row('a/b', 1), row('old/name', 3), row('new/name', 2), row('gone/x', 1), row('not/yet', 1)], details, (a, b) => a.reddit.time > b.reddit.time);
  assert.deepEqual(repos.map((r) => [r.name, r.stars, r.reddit.time]), [['a/b', 5, 1], ['new/name', 9, 3]]);
  assert.deepEqual(unknown.map((r) => r.name), ['not/yet']);
});
