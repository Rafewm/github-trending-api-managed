import test from 'node:test';
import assert from 'node:assert/strict';
import { growth, mergeTrending, dropStarred, dropRecentStars } from './trending.js';

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

test('mergeSources joins the same repo from both sources into one entry', async () => {
  const { mergeSources } = await import('./trending.js');
  const out = mergeSources(
    [{ name: 'a/b', description: 'from monitor', release: { version: 'v1' } }],
    [{ name: 'A/B', description: '', reddit: { id: 'x' } }, { name: 'c/d', description: '', reddit: { id: 'y' } }],
  );
  assert.deepEqual(out, [
    { name: 'a/b', description: 'from monitor', release: { version: 'v1' }, reddit: { id: 'x' } },
    { name: 'c/d', description: '', reddit: { id: 'y' } },
  ]);
});
