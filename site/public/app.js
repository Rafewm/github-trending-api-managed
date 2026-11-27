const PAGE = 100;
const DAY_MS = 86400000;
const $ = (id) => document.getElementById(id);
// Hidden lists saved in this browser before the server kept them; moved to the server once.
const LOCAL_HIDDEN = 'unstarred.hidden';
const HIDE_KEY = 'unstarred.key';
const SORTS = {
  trending: [
    ['day.add', 'Daily stars'],
    ['day.pct', 'Daily growth %'],
    ['week.pct', 'Weekly growth %'],
    ['week.add', 'Weekly stars'],
    ['month.pct', 'Monthly growth %'],
    ['month.add', 'Monthly stars'],
    ['stars', 'Total stars'],
  ],
  hn: [
    ['hn.points', 'HN points'],
    ['hn.comments', 'HN comments'],
    ['hn.time', 'Newest on HN'],
    ['stars', 'Total stars'],
  ],
  new: [
    ['created.perDay', 'Stars per day'],
    ['stars', 'Total stars'],
    ['created.time', 'Newest'],
  ],
  skills: [
    ['stars', 'Total stars'],
    ['created.perDay', 'Stars per day'],
    ['created.time', 'Newest'],
  ],
  twitter: [
    ['tweet.time', 'Newest on X'],
    ['tweet.likes', 'Post likes'],
    ['stars', 'Total stars'],
  ],
  releases: [
    ['release.score', 'Release Monitor rank'],
    ['reddit.time', 'Newest on Reddit'],
    ['stars', 'Total stars'],
  ],
};
const COLUMNS = {
  trending: ['Lang', 'Stars', 'Day', 'Week', 'Month', 'Status'],
  hn: ['Lang', 'Stars', 'Points', 'Comments', 'Posted', 'Status'],
  new: ['Lang', 'Stars', 'Per day', 'Created', 'Status'],
  skills: ['Lang', 'Stars', 'Type', 'Created', 'Status'],
  twitter: ['Lang', 'Stars', 'Likes', 'Posted', 'Status'],
  releases: ['Lang', 'Stars', 'Release', 'Reddit', 'Status'],
};
// Tabs that load one list per period, on first open.
const FEEDS = {
  hn: {
    url: (period) => `/api/hn?period=${period}`,
    periods: [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly'], ['all', 'All time']],
    label: 'Hacker News',
  },
  new: {
    url: (period) => `/api/new?period=${period}`,
    periods: [
      ['3', 'Last 3 days, 50+ stars'],
      ['30', 'Last 30 days, 100+ stars'],
      ['90', 'Last 90 days, 100+ stars'],
      ['365', 'Last year, 300+ stars'],
      ['730', 'Last 2 years, 500+ stars'],
      ['all', 'All time, top 1,000 with 1K+ stars'],
    ],
    label: 'new repositories',
  },
  skills: {
    url: (type) => `/api/skills?type=${type}`,
    title: 'Type',
    periods: [
      ['all', 'All types'],
      ['mcp', 'MCP servers'],
      ['claude', 'Claude skills'],
      ['codex', 'Codex and OpenClaw'],
      ['agent', 'Agent tools'],
      ['skill', 'Other skills'],
      ['tool', 'Other tools'],
    ],
    label: 'skills',
  },
  twitter: {
    url: (days) => `/api/twitter?days=${days}`,
    periods: [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['365', 'Last year']],
    label: 'posts from X',
  },
  releases: {
    url: (period) => `/api/releases?days=${period}`,
    periods: [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['365', 'Last year']],
    label: 'releases',
  },
};
let browse = null;
const feeds = { hn: {}, new: {}, skills: {}, twitter: {}, releases: {} };
const periodChoice = { hn: 'day', new: '30', skills: 'all', twitter: '7', releases: '7' };
let limit = PAGE;
let view = 'browse';
let hidden = {};
let tracked = {};
let storeReady = false;
// Bumped when a Hide/Track save starts and when it ends, so a refresh that overlapped one can tell.
let listEdits = 0;
let listQueue = Promise.resolve();
const SAVE_DELAY = 800;
// The lists' version from the server; they're downloaded again only when it changes.
let listsVersion = null;
// Your newest stars, checked when you come back to the tab, so a repo you just starred leaves at once.
let newStars = new Set();
// Repos starred with the Star button. Kept apart from newStars, which each check replaces.
const siteStars = new Set();
const sortChoice = { trending: 'day.add', hn: 'hn.points', new: 'created.perDay', skills: 'stars', twitter: 'tweet.time', releases: 'release.score' };

const kind = () => (FEEDS[view] ? view : 'trending');
const source = () => (FEEDS[view] ? feeds[view][periodChoice[view]] : browse);

function storage(fn) {
  try {
    return fn(localStorage);
  } catch {
    return null;
  }
}

function showError(text) {
  $('message').hidden = false;
  $('message').textContent = text;
}

// Returns the server's new list ('hidden' or 'tracked'), or null when no key was entered.
function hideKey() {
  let key = storage((s) => s.getItem(HIDE_KEY));
  if (!key) {
    key = prompt('Enter your hide key to change your lists.')?.trim();
    if (!key) return null;
    storage((s) => s.setItem(HIDE_KEY, key));
  }
  return key;
}

async function saveList(list, change) {
  const key = hideKey();
  if (!key) return null;
  const res = await fetch(`/api/${list}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hide-Key': key },
    body: JSON.stringify(change),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) storage((s) => s.removeItem(HIDE_KEY));
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data;
}

// Clicks on one list within SAVE_DELAY go out as one save (each save is a commit, and GitHub limits how fast those
// may come), and saves run one at a time. The page already shows the change, so the reply is only the new version.
const pendingChanges = {};
function queueSave(list, change) {
  listEdits++;
  let batch = pendingChanges[list];
  if (!batch) {
    batch = pendingChanges[list] = { hide: new Map(), unhide: new Set() };
    batch.job = new Promise((resolve) => setTimeout(resolve, SAVE_DELAY)).then(() => {
      delete pendingChanges[list];
      const job = listQueue.then(() => saveList(list, { hide: [...batch.hide.values()], unhide: [...batch.unhide] }));
      listQueue = job.catch(() => {});
      return job;
    });
  }
  // A later click on the same repo replaces an earlier one in the batch.
  for (const repo of change.hide ?? []) (batch.unhide.delete(repo.name), batch.hide.set(repo.name, repo));
  for (const name of change.unhide ?? []) (batch.hide.delete(name), batch.unhide.add(name));
  return batch.job
    .then((saved) => {
      // Only once the lists are loaded: before that, the saved version would stop them from ever being downloaded.
      if (saved && listsVersion) listsVersion = saved.version;
      return saved;
    })
    .finally(() => listEdits++);
}

const localHidden = () => storage((s) => JSON.parse(s.getItem(LOCAL_HIDDEN))) ?? {};

async function moveLocalHidden() {
  const list = Object.values(localHidden());
  // Never prompt on page load: wait until a key is saved by the first Hide or Unhide.
  if (!storeReady || !list.length || !storage((s) => s.getItem(HIDE_KEY))) return;
  try {
    if (!(await queueSave('hidden', { hide: list }))) return;
    storage((s) => s.removeItem(LOCAL_HIDDEN));
    render();
  } catch (err) {
    showError(`Could not move hidden repositories to the server: ${err.message}`);
  }
}

const savedView = () => view === 'hidden' || view === 'tracked';

// Hidden and tracked entries are snapshots so they stay listed after a repo leaves trending.
function currentList() {
  if (!savedView()) return (source()?.repos ?? []).filter((r) => !hidden[r.name] && !tracked[r.name] && !newStars.has(r.name) && !siteStars.has(r.name));
  const loaded = Object.values(feeds).flatMap((byPeriod) => Object.values(byPeriod).flatMap((d) => d.repos));
  const live = new Map([...loaded, ...(browse?.repos ?? [])].map((r) => [r.name, r]));
  return Object.values(view === 'hidden' ? hidden : tracked).map((r) => live.get(r.name) ?? r);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function short(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  if (days < 1) return 'Today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// data-label names each value when phones show rows as cards without the table header.
function growthCell(g, label) {
  if (!g) return `<td class="muted nowrap" data-label="${label}">No data</td>`;
  const pct = g.pct === null ? 'New' : `${g.pct.toFixed(2)}%`;
  return `<td class="nowrap growth" data-label="${label}"><span aria-hidden="true">↗</span> ${pct}<br><span class="add">+${g.add.toLocaleString('en-US')}</span></td>`;
}

function hnCells(h) {
  return `<td class="nowrap hn-points" data-label="Points"><span aria-hidden="true">▲</span> ${h.points.toLocaleString('en-US')}</td>
    <td class="nowrap" data-label="Comments">${h.comments.toLocaleString('en-US')}</td>
    <td class="nowrap" data-label="Posted">${ago(new Date(h.time * 1000).toISOString())}</td>`;
}

const redditUrl = (post) => `https://www.reddit.com/r/${esc(post.sub ?? 'BestGitHubRepos')}/comments/${esc(post.id)}/`;

// Release Monitor version and Reddit post date; a repo can come from one source or both.
function releaseCells(repo) {
  const releases = `https://github.com/${esc(repo.name)}/releases`;
  const version = repo.release
    ? `<a href="${releases}" target="_blank" rel="noopener noreferrer" aria-label="${esc(repo.name)} releases">${esc(repo.release.version || 'Releases')}</a>`
    : '<span class="muted">-</span>';
  const post = repo.reddit
    ? `<a href="${redditUrl(repo.reddit)}" target="_blank" rel="noopener noreferrer" aria-label="Reddit post about ${esc(repo.name)}">${ago(new Date(repo.reddit.time * 1000).toISOString())}</a>`
    : '<span class="muted">-</span>';
  return `<td class="nowrap release" data-label="Release">${version}</td><td class="nowrap release" data-label="Reddit">${post}</td>`;
}

// GitHub search gives no daily growth, so stars per day since the repo was made stands in for it.
function newCells(c) {
  return `<td class="nowrap growth" data-label="Per day"><span aria-hidden="true">↗</span> ${c.perDay.toLocaleString('en-US')}</td>
    <td class="nowrap" data-label="Created">${ago(new Date(c.time * 1000).toISOString())}</td>`;
}

const tweetUrl = (t) => `https://x.com/${encodeURIComponent(t.user)}/status/${encodeURIComponent(t.id)}`;

function tweetCells(t) {
  return `<td class="nowrap hn-points" data-label="Likes"><span aria-hidden="true">♥</span> ${t.likes.toLocaleString('en-US')}</td>
    <td class="nowrap" data-label="Posted"><a href="${tweetUrl(t)}" target="_blank" rel="noopener noreferrer">@${esc(t.user)}</a><br><span class="muted">${ago(new Date(t.time * 1000).toISOString())}</span></td>`;
}

const skillLabel = (type) => new Map(FEEDS.skills.periods).get(type) ?? 'Other tools';

function skillCells(repo) {
  return `<td class="nowrap" data-label="Type">${esc(skillLabel(repo.skill))}</td>
    <td class="nowrap" data-label="Created">${ago(new Date(repo.created.time * 1000).toISOString())}</td>`;
}

function statusCell(repo) {
  if (repo.archived) return '<td class="nowrap status off" data-label="Status"><span aria-hidden="true">●</span> Archived</td>';
  const active = repo.pushedAt && Date.now() - Date.parse(repo.pushedAt) < 90 * DAY_MS;
  const label = active ? 'Active' : 'Inactive';
  const when = repo.pushedAt ? ago(repo.pushedAt) : 'Never pushed';
  return `<td class="nowrap status ${active ? 'on' : 'off'}" data-label="Status"><span aria-hidden="true">●</span> ${label}<br><span class="muted">${when}</span></td>`;
}

function row(repo) {
  const [owner, name] = repo.name.split('/');
  const url = `https://github.com/${esc(repo.name)}`;
  const story = view === 'hn' ? repo.hn : null;
  const hnUrl = story && `https://news.ycombinator.com/item?id=${esc(story.id)}`;
  const color = /^#[0-9a-f]{3,8}$/i.test(repo.languageColor) ? repo.languageColor : '#64748b';
  const lang = repo.language
    ? `<span class="lang-dot" style="background:${color}"></span>${esc(repo.language)}`
    : '<span class="muted">-</span>';
  const tags = repo.topics.length
    ? `<ul class="tags" aria-label="Topics">${repo.topics.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';
  const post = view === 'releases' ? repo.reddit : null;
  const tweet = view === 'twitter' ? repo.tweet : null;
  const title = tweet
    ? `<a class="hn-title" href="${tweetUrl(tweet)}" target="_blank" rel="noopener noreferrer">${esc(tweet.text.length > 280 ? `${tweet.text.slice(0, 280)}…` : tweet.text)}</a>`
    : story
    ? `<a class="hn-title" href="${hnUrl}" target="_blank" rel="noopener noreferrer">${esc(story.title)}</a>`
    : post
      ? `<a class="hn-title" href="${redditUrl(post)}" target="_blank" rel="noopener noreferrer">${esc(post.title)}</a>`
      : '';
  const button = (cls, list, label, text, pressed) =>
    `<button class="${cls}" type="button" data-toggle="${esc(repo.name)}" data-list="${list}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`} aria-label="${label} ${esc(repo.name)}">${text}</button>`;
  const isTracked = Boolean(tracked[repo.name]);
  // Hide and Track are exclusive, so in the Hidden and Track tabs the other button moves the repo across.
  const hideButton = button('open', 'hidden', view === 'hidden' ? 'Unhide' : 'Hide', view === 'hidden' ? 'Unhide' : 'Hide');
  const trackLabel = view === 'tracked' ? 'Untrack' : isTracked ? 'Tracked' : 'Track';
  const trackButton = button(
    'track-corner',
    'tracked',
    trackLabel,
    `<span aria-hidden="true">${isTracked ? '★' : '☆'}</span> ${trackLabel}`,
    view === 'tracked' ? undefined : isTracked,
  );
  return `<tr>
    <td class="col-avatar"><img class="avatar" src="${esc(repo.avatar)}" alt="" width="28" height="28" loading="lazy"></td>
    <td class="project"><a href="${url}" target="_blank" rel="noopener noreferrer">${esc(name)}</a><br><span class="muted">${esc(owner)}/${esc(name)}</span></td>
    <td class="col-desc">${title}<p class="desc">${esc(repo.description)}</p>${tags}</td>
    <td class="nowrap" data-label="Lang">${lang}</td>
    <td class="nowrap stars" data-label="Stars"><span class="star" aria-hidden="true">★</span> ${short(repo.stars)}</td>
    ${
      story
        ? hnCells(story)
        : view === 'releases'
          ? releaseCells(repo)
          : view === 'new' && repo.created
            ? newCells(repo.created)
            : view === 'skills' && repo.skill
              ? skillCells(repo)
              : tweet
                ? tweetCells(tweet)
          : `${growthCell(repo.day, 'Day')}${growthCell(repo.week, 'Week')}${growthCell(repo.month, 'Month')}`
    }
    ${statusCell(repo)}
    <td class="col-actions">${trackButton}<div class="actions">
      <button class="open" type="button" data-star="${esc(repo.name)}" aria-label="Star ${esc(repo.name)} on GitHub"><span aria-hidden="true">★</span> Star</button>
      ${hideButton}
      <a class="open" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(repo.name)} on GitHub">GitHub ↗</a>
      ${story ? `<a class="open" href="${hnUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open the Hacker News discussion for ${esc(repo.name)}">HN ↗</a>` : ''}
    </div></td>
  </tr>`;
}

function sortValue(repo, key) {
  const value = key.split('.').reduce((o, k) => o?.[k], repo);
  return value ?? -1;
}

function setSorts() {
  const k = kind();
  $('sort').replaceChildren(...SORTS[k].map(([value, label]) => new Option(label, value)));
  $('sort').value = sortChoice[k];
}

function renderHeader() {
  const cols = COLUMNS[kind()].map((c) => `<th scope="col">${c}</th>`).join('');
  $('thead').innerHTML = `<tr>
    <th scope="col"><span class="sr-only">Owner</span></th>
    <th scope="col">Project</th>
    <th scope="col" class="col-desc">${view === 'hn' ? 'Story' : view === 'twitter' ? 'Post' : 'Description'}</th>
    ${cols}
    <th scope="col"><span class="sr-only">Actions</span></th>
  </tr>`;
}

function renderStats() {
  const data = source();
  const fmt = (n) => (data ? n.toLocaleString('en-US') : '-');
  $('stat-tracked').textContent = fmt(data?.tracked);
  $('stat-hidden').textContent = fmt(data?.hiddenStarred);
  $('stat-visible').textContent = fmt(data?.repos.length);
  $('refreshed').textContent = data?.refreshed ? `Refreshed ${ago(new Date(data.refreshed).toISOString()).toLowerCase()}` : '';
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const language = $('language').value;
  const min = Number($('min').value);
  const topics = $('topics').value.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const key = $('sort').value;

  const hiddenTotal = Object.keys(hidden).length;
  const trackedTotal = Object.keys(tracked).length;
  $('hidden-count').textContent = hiddenTotal ? `(${hiddenTotal})` : '';
  $('tracked-count').textContent = trackedTotal ? `(${trackedTotal})` : '';
  $('results-title').textContent = {
    browse: 'Projects',
    hn: 'On Hacker News',
    new: 'New and rising',
    skills: 'Agent skills and MCP',
    twitter: 'Repos on X',
    releases: 'New releases',
    tracked: 'Tracked projects',
    hidden: 'Hidden projects',
  }[view];
  for (const v of ['browse', 'new', 'skills', 'twitter', 'hn', 'releases', 'tracked', 'hidden']) $(`tab-${v}`).setAttribute('aria-pressed', view === v);
  $('period-label').hidden = !FEEDS[view];
  $('source-label').hidden = view !== 'releases';
  renderHeader();
  renderStats();

  if (!savedView() && !source()) return; // still loading; the loader shows its own message
  if (listsState === 'loading') {
    $('table-wrap').hidden = true;
    $('more').hidden = true;
    showError('Loading your Hidden and Track lists...');
    return;
  }

  const releaseSource = $('source').value;
  const matches = currentList()
    .filter((r) => view !== 'releases' || releaseSource === 'both' || r[{ reddit: 'reddit', releasemonitor: 'release', github: 'github' }[releaseSource]])
    .filter((r) => !language || r.language === language)
    .filter((r) => r.stars >= min)
    .filter((r) => !q || `${r.name} ${r.description} ${r.hn?.title ?? ''} ${r.release?.title ?? ''} ${r.reddit?.title ?? ''} ${r.tweet?.text ?? ''}`.toLowerCase().includes(q))
    .filter((r) => topics.every((t) => r.topics.some((name) => name.includes(t))))
    .sort((a, b) => sortValue(b, key) - sortValue(a, key));

  const failed = view === 'releases' ? source()?.failed ?? [] : [];
  $('matches').textContent =
    `${matches.length.toLocaleString('en-US')} matches` +
    (failed.length ? ` · ${failed.join(' and ')} unavailable` : '') +
    (listsState === 'failed' ? ' · Hidden and Track lists could not load; retrying when you come back to this tab' : '') +
    (source()?.loadingMore ? ' · loading more...' : '') +
    (source()?.loadError ? ` · could not load the rest: ${source().loadError}` : '');
  $('rows').innerHTML = matches.slice(0, limit).map(row).join('');
  $('more').hidden = matches.length <= limit;
  $('table-wrap').hidden = matches.length === 0;
  $('message').hidden = matches.length > 0;
  $('message').textContent =
    view === 'hidden' && !hiddenTotal
      ? 'You have not hidden any repositories.'
      : view === 'tracked' && !trackedTotal
        ? 'You are not tracking any repositories. Press Track on a repo to save it here.'
        : view === 'releases' && releaseSource === 'releasemonitor' && periodChoice.releases === '365'
          ? 'Release Monitor only covers up to 30 days. Pick a shorter period or the Reddit source.'
          : 'No repositories match these filters.';
}

function showLoading(text) {
  $('matches').textContent = '';
  $('table-wrap').hidden = true;
  $('more').hidden = true;
  showError(text);
}

// Long lists come in pages of 5,000 (the server's responses must stay under 4.5 MB).
async function fetchFeedPage(name, period, page) {
  const res = await fetch(`${FEEDS[name].url(period)}&page=${page}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// Adds pages after the first until there are no more. A list rebuilt between two requests can shift a repo onto both.
async function addPages(name, period, data, onPage) {
  const seen = new Set(data.repos.map((r) => r.name));
  for (let page = 1; page <= 50; page++) {
    const next = await fetchFeedPage(name, period, page);
    const added = next.repos.filter((r) => !seen.has(r.name));
    added.forEach((r) => seen.add(r.name));
    data.repos = data.repos.concat(added);
    onPage?.(added);
    if (!next.more) break;
  }
}

// First load: the first page shows at once and the rest load behind it, so a slow connection sees results early.
async function loadFeed(name, period) {
  const data = await fetchFeedPage(name, period, 0);
  data.loadingMore = data.more;
  feeds[name][period] = data;
  fillOptions(data.repos);
  if (!data.more) return;
  const current = () => feeds[name][period] === data && view === name && periodChoice[name] === period;
  addPages(name, period, data, (added) => {
    fillOptions(added);
    if (current()) render();
  })
    .catch((err) => (data.loadError = err.message))
    .finally(() => {
      data.loadingMore = false;
      if (current()) render();
    });
}

// Refresh: the whole new list is fetched first, so the shown list never shrinks back to its first page.
async function reloadFeed(name, period) {
  const data = await fetchFeedPage(name, period, 0);
  if (data.more) await addPages(name, period, data);
  feeds[name][period] = data;
  fillOptions(data.repos);
}

async function showFeed() {
  limit = PAGE;
  render();
  const name = view;
  const period = periodChoice[name];
  if (feeds[name][period]) return;
  showLoading(`Loading ${FEEDS[name].label} and checking your stars...`);
  try {
    await loadFeed(name, period);
    if (view === name && periodChoice[name] === period) render();
  } catch (err) {
    showError(`Could not load ${FEEDS[name].label}: ${err.message}`);
  }
}

function setPeriods() {
  if (!FEEDS[view]) return;
  $('period-label').firstChild.textContent = `${FEEDS[view].title ?? 'Period'} `;
  $('period').replaceChildren(...FEEDS[view].periods.map(([value, label]) => new Option(label, value)));
  $('period').value = periodChoice[view];
}

function setView(next) {
  view = next;
  limit = PAGE;
  setSorts();
  setPeriods();
  if (FEEDS[view]) return showFeed();
  render();
}

// The page changes at once and the save runs behind it; a failed or cancelled save undoes this repo's change only,
// since other clicks saved in the same batch undo their own.
async function toggleList(button) {
  const { toggle: name, list } = button.dataset;
  const other = list === 'hidden' ? 'tracked' : 'hidden';
  const before = { hidden: hidden[name], tracked: tracked[name] };
  const adding = !before[list];
  const repo = adding && currentList().find((r) => r.name === name);
  const index = [...$('rows').querySelectorAll('[data-toggle]')].indexOf(button);
  const lists = { hidden, tracked };
  if (adding) {
    lists[list][name] = repo;
    delete lists[other][name];
  } else delete lists[list][name];
  render();
  // The clicked row may be gone, so keep keyboard focus at the same place in the list.
  const next = $('rows').querySelectorAll('[data-toggle]');
  (next[index] ?? next[next.length - 1] ?? $(`tab-${view}`)).focus();
  try {
    // Add first, then remove from the other list, so a failed second step never loses the repo.
    const saved = await queueSave(list, adding ? { hide: [repo] } : { unhide: [name] });
    if (saved && adding && before[other]) await queueSave(other, { unhide: [name] });
    if (!saved) throw null;
    moveLocalHidden();
  } catch (err) {
    for (const [key, entry] of Object.entries(before)) {
      const current = key === 'hidden' ? hidden : tracked;
      if (entry) current[name] = entry;
      else delete current[name];
    }
    render();
    if (err) showError(`Could not update the ${list} list: ${err.message}`);
  }
}

// Stars on GitHub through the server. The row leaves at once and comes back if the star fails.
async function starRepo(button) {
  const name = button.dataset.star;
  const key = hideKey();
  if (!key) return;
  const lists = { hidden, tracked };
  // A starred repo has no place in Hidden or Track, so starring one there also takes it off that list.
  const list = savedView() ? view : null;
  const entry = list && lists[list][name];
  const index = [...$('rows').querySelectorAll('[data-star]')].indexOf(button);
  siteStars.add(name);
  if (entry) delete lists[list][name];
  render();
  const next = $('rows').querySelectorAll('[data-star]');
  (next[index] ?? next[next.length - 1] ?? $(`tab-${view}`)).focus();
  try {
    const res = await fetch('/api/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hide-Key': key },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) storage((s) => s.removeItem(HIDE_KEY));
    if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  } catch (err) {
    siteStars.delete(name);
    if (entry) (list === 'hidden' ? hidden : tracked)[name] = entry;
    render();
    showError(`Could not star ${name}: ${err.message}`);
    return;
  }
  if (entry) queueSave(list, { unhide: [name] }).catch((err) => showError(`Starred, but could not update the ${list} list: ${err.message}`));
}

async function checkStars() {
  try {
    const res = await fetch('/api/stars', { cache: 'no-store' });
    if (!res.ok) return;
    const names = await res.json();
    if (names.some((n) => !newStars.has(n))) {
      newStars = new Set(names);
      render();
    }
  } catch {
    // The full refresh that follows still drops starred repos.
  }
}

// Merges new languages and topics into the filter choices, keeping the current selection.
function fillOptions(list) {
  const select = $('language');
  const chosen = select.value;
  const languages = new Set([...select.options].slice(1).map((o) => o.value));
  list.forEach((r) => r.language && languages.add(r.language));
  select.replaceChildren(
    new Option('All languages', ''),
    ...[...languages].sort((a, b) => a.localeCompare(b)).map((l) => new Option(l, l)),
  );
  select.value = chosen;
  const topics = new Set([...$('topic-list').options].map((o) => o.value));
  list.forEach((r) => r.topics.forEach((t) => topics.add(t)));
  $('topic-list').replaceChildren(...[...topics].sort().map((t) => new Option(t)));
}

// Hidden and Track load first and on their own, never waiting on the slow lists. Repo rows stay hidden until they
// arrive, so nothing you hid shows up and no click lands before them.
const LISTS_RAW = 'https://raw.githubusercontent.com/Rafewm/github-trending-api-managed';
let listsState = 'loading';
let listsLoading = null;

function loadLists() {
  if (listsLoading) return listsLoading;
  listsLoading = (async () => {
    const edits = listEdits;
    try {
      const res = await fetch('/api/lists-version');
      if (!res.ok) throw new Error(`lists version: ${res.status}`);
      const { version } = await res.json();
      if (version !== listsVersion) {
        // The files at an exact commit come from GitHub's file CDN: fast, current, and they don't use the server's token.
        const get = async (name) => {
          const raw = await fetch(`${LISTS_RAW}/${version}/lists/${name}.json`).catch(() => null);
          if (raw?.ok) return raw.json();
          const api = await fetch(`/api/${name}`);
          if (!api.ok) throw new Error(`${name} list: ${api.status}`);
          return api.json();
        };
        const [hiddenData, trackedData] = await Promise.all([get('hidden'), get('tracked')]);
        // A click made while they downloaded isn't in them, so keep the page's lists and download again next time.
        if (edits === listEdits) {
          hidden = hiddenData;
          tracked = trackedData;
          listsVersion = version;
        }
      }
      storeReady = true;
      listsState = 'ready';
    } catch (err) {
      console.error(err);
      storeReady = false;
      // Without the store, show what this browser hid so the page stays usable; lists already loaded are kept.
      if (listsState !== 'ready') {
        hidden = localHidden();
        listsState = 'failed';
      }
    } finally {
      listsLoading = null;
    }
    render();
  })();
  return listsLoading;
}

async function refresh() {
  loadLists();
  try {
    const res = await fetch('/api/repos');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (FEEDS[view] && feeds[view][periodChoice[view]] && !feeds[view][periodChoice[view]].loadingMore) {
      await reloadFeed(view, periodChoice[view]);
    }
    const first = !browse;
    const changed = first || JSON.stringify(data.repos) !== JSON.stringify(browse.repos);
    browse = data;
    if (first) fillOptions(browse.repos);
    if (changed || FEEDS[view]) render();
  } catch (err) {
    showError(`Could not load repositories: ${err.message}`);
  }
}

for (const id of ['q', 'language', 'min', 'topics']) {
  $(id).addEventListener('input', () => {
    limit = PAGE;
    render();
  });
}
$('sort').addEventListener('input', () => {
  sortChoice[kind()] = $('sort').value;
  limit = PAGE;
  render();
});
$('source').addEventListener('input', () => {
  // The GitHub source has no rank or Reddit date, so its natural order is total stars.
  if ($('source').value === 'github') $('sort').value = sortChoice.releases = 'stars';
  limit = PAGE;
  render();
});
$('period').addEventListener('input', () => {
  periodChoice[view] = $('period').value;
  showFeed();
});
$('filters').addEventListener('submit', (e) => e.preventDefault());
$('more').addEventListener('click', () => {
  limit += PAGE;
  render();
});
$('tab-browse').addEventListener('click', () => setView('browse'));
$('tab-new').addEventListener('click', () => setView('new'));
$('tab-skills').addEventListener('click', () => setView('skills'));
$('tab-twitter').addEventListener('click', () => setView('twitter'));
$('tab-hn').addEventListener('click', () => setView('hn'));
$('tab-releases').addEventListener('click', () => setView('releases'));
$('tab-tracked').addEventListener('click', () => setView('tracked'));
$('tab-hidden').addEventListener('click', () => setView('hidden'));
$('rows').addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) return starRepo(star);
  const button = e.target.closest('[data-toggle]');
  if (button && !button.disabled) toggleList(button);
});
// Coming back from GitHub after starring something updates the list without a manual reload.
window.addEventListener('focus', () => {
  checkStars();
  refresh();
});
setSorts();
refresh();
loadLists().then(moveLocalHidden);
