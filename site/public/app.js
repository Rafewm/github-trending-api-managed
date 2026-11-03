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
};
const COLUMNS = {
  trending: ['Lang', 'Stars', 'Day', 'Week', 'Month', 'Status'],
  hn: ['Lang', 'Stars', 'Points', 'Comments', 'Posted', 'Status'],
};
let browse = null;
const hn = {};
let hnPeriod = 'day';
let limit = PAGE;
let view = 'browse';
let hidden = {};
let storeReady = false;
const sortChoice = { trending: 'day.add', hn: 'hn.points' };

const kind = () => (view === 'hn' ? 'hn' : 'trending');
const source = () => (view === 'hn' ? hn[hnPeriod] : browse);

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

// Returns the server's new hidden list, or null when no key was entered.
async function saveHidden(change) {
  let key = storage((s) => s.getItem(HIDE_KEY));
  if (!key) {
    key = prompt('Enter your hide key to change the hidden list.')?.trim();
    if (!key) return null;
    storage((s) => s.setItem(HIDE_KEY, key));
  }
  const res = await fetch('/api/hidden', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hide-Key': key },
    body: JSON.stringify(change),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) storage((s) => s.removeItem(HIDE_KEY));
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data;
}

const localHidden = () => storage((s) => JSON.parse(s.getItem(LOCAL_HIDDEN))) ?? {};

async function moveLocalHidden() {
  const list = Object.values(localHidden());
  // Never prompt on page load: wait until a key is saved by the first Hide or Unhide.
  if (!storeReady || !list.length || !storage((s) => s.getItem(HIDE_KEY))) return;
  try {
    const next = await saveHidden({ hide: list });
    if (!next) return;
    storage((s) => s.removeItem(LOCAL_HIDDEN));
    hidden = next;
    render();
  } catch (err) {
    showError(`Could not move hidden repositories to the server: ${err.message}`);
  }
}

// Hidden entries are snapshots so they stay listed after a repo leaves trending.
function currentList() {
  if (view !== 'hidden') return (source()?.repos ?? []).filter((r) => !hidden[r.name]);
  const live = new Map([...Object.values(hn).flatMap((d) => d.repos), ...(browse?.repos ?? [])].map((r) => [r.name, r]));
  return Object.values(hidden).map((r) => live.get(r.name) ?? r);
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
  const title = story
    ? `<a class="hn-title" href="${hnUrl}" target="_blank" rel="noopener noreferrer">${esc(story.title)}</a>`
    : '';
  const action = view === 'hidden' ? 'Unhide' : 'Hide';
  return `<tr>
    <td class="col-avatar"><img class="avatar" src="${esc(repo.avatar)}" alt="" width="28" height="28" loading="lazy"></td>
    <td class="project"><a href="${url}" target="_blank" rel="noopener noreferrer">${esc(name)}</a><br><span class="muted">${esc(owner)}/${esc(name)}</span></td>
    <td class="col-desc">${title}<p class="desc">${esc(repo.description)}</p>${tags}</td>
    <td class="nowrap" data-label="Lang">${lang}</td>
    <td class="nowrap stars" data-label="Stars"><span class="star" aria-hidden="true">★</span> ${short(repo.stars)}</td>
    ${story ? hnCells(story) : `${growthCell(repo.day, 'Day')}${growthCell(repo.week, 'Week')}${growthCell(repo.month, 'Month')}`}
    ${statusCell(repo)}
    <td class="col-actions"><div class="actions">
      <button class="open" type="button" data-toggle="${esc(repo.name)}" aria-label="${action} ${esc(repo.name)}">${action}</button>
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
    <th scope="col" class="col-desc">${view === 'hn' ? 'Story' : 'Description'}</th>
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
  $('hidden-count').textContent = hiddenTotal ? `(${hiddenTotal})` : '';
  $('results-title').textContent = { browse: 'Projects', hn: 'On Hacker News', hidden: 'Hidden projects' }[view];
  for (const v of ['browse', 'hn', 'hidden']) $(`tab-${v}`).setAttribute('aria-pressed', view === v);
  $('hn-period-label').hidden = view !== 'hn';
  renderHeader();
  renderStats();

  if (view !== 'hidden' && !source()) return; // still loading; the loader shows its own message

  const matches = currentList()
    .filter((r) => !language || r.language === language)
    .filter((r) => r.stars >= min)
    .filter((r) => !q || `${r.name} ${r.description} ${r.hn?.title ?? ''}`.toLowerCase().includes(q))
    .filter((r) => topics.every((t) => r.topics.some((name) => name.includes(t))))
    .sort((a, b) => sortValue(b, key) - sortValue(a, key));

  $('matches').textContent = `${matches.length.toLocaleString('en-US')} matches`;
  $('rows').innerHTML = matches.slice(0, limit).map(row).join('');
  $('more').hidden = matches.length <= limit;
  $('table-wrap').hidden = matches.length === 0;
  $('message').hidden = matches.length > 0;
  $('message').textContent =
    view === 'hidden' && !hiddenTotal ? 'You have not hidden any repositories.' : 'No repositories match these filters.';
}

function showLoading(text) {
  $('matches').textContent = '';
  $('table-wrap').hidden = true;
  $('more').hidden = true;
  showError(text);
}

async function loadHn(period) {
  const res = await fetch(`/api/hn?period=${period}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  hn[period] = data;
  fillOptions(data.repos);
}

async function showHn() {
  limit = PAGE;
  render();
  if (hn[hnPeriod]) return;
  const period = hnPeriod;
  showLoading('Loading Hacker News stories and checking your stars...');
  try {
    await loadHn(period);
    if (view === 'hn' && hnPeriod === period) render();
  } catch (err) {
    showError(`Could not load Hacker News: ${err.message}`);
  }
}

function setView(next) {
  view = next;
  limit = PAGE;
  setSorts();
  if (view === 'hn') return showHn();
  render();
}

async function toggleHidden(button) {
  const name = button.dataset.toggle;
  const buttons = [...$('rows').querySelectorAll('[data-toggle]')];
  const index = buttons.indexOf(button);
  button.disabled = true;
  try {
    const change = hidden[name] ? { unhide: [name] } : { hide: [currentList().find((r) => r.name === name)] };
    const next = await saveHidden(change);
    if (!next) return;
    hidden = next;
    moveLocalHidden();
  } catch (err) {
    showError(`Could not update the hidden list: ${err.message}`);
    return;
  } finally {
    button.disabled = false;
  }
  render();
  // The clicked row is gone, so keep keyboard focus at the same place in the list.
  const next = $('rows').querySelectorAll('[data-toggle]');
  (next[index] ?? next[next.length - 1] ?? $(`tab-${view}`)).focus();
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

async function refresh() {
  try {
    const [res, hiddenRes] = await Promise.all([fetch('/api/repos'), fetch('/api/hidden')]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // Without a working store, keep showing what this browser hid so the page stays usable.
    storeReady = hiddenRes.ok;
    const hiddenData = storeReady ? await hiddenRes.json() : localHidden();
    if (view === 'hn' && hn[hnPeriod]) await loadHn(hnPeriod);
    const first = !browse;
    const changed = first || JSON.stringify([data.repos, hiddenData]) !== JSON.stringify([browse.repos, hidden]);
    browse = data;
    hidden = hiddenData;
    if (first) fillOptions(browse.repos);
    if (changed || view === 'hn') render();
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
$('hn-period').addEventListener('input', () => {
  hnPeriod = $('hn-period').value;
  showHn();
});
$('filters').addEventListener('submit', (e) => e.preventDefault());
$('more').addEventListener('click', () => {
  limit += PAGE;
  render();
});
$('tab-browse').addEventListener('click', () => setView('browse'));
$('tab-hn').addEventListener('click', () => setView('hn'));
$('tab-hidden').addEventListener('click', () => setView('hidden'));
$('rows').addEventListener('click', (e) => {
  const button = e.target.closest('[data-toggle]');
  if (button && !button.disabled) toggleHidden(button);
});
// Coming back from GitHub after starring something updates the list without a manual reload.
window.addEventListener('focus', refresh);
setSorts();
refresh().then(moveLocalHidden);
