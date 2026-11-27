# GitHub Trending API + Unstarred

Two things live in this repo:

1. **A trending data API.** A GitHub Action scrapes [GitHub Trending](https://github.com/trending) every 4 hours, adds the live [Trendshift](https://trendshift.io) rankings, collects agent skills and MCP servers, and commits the results as static JSON and RSS files under [`data/`](data).
2. **Unstarred**, a website in [`site/`](site) for browsing that data, new repositories gaining stars fast, agent skills and MCP servers, GitHub projects on Hacker News and notable new releases, with every repo you have already starred filtered out.

[简体中文](README_zh-CN.md) (describes the original data API only)

---

## Data API

Files are plain JSON (and RSS) served by GitHub, so there is no key, server or rate limit to manage.

```
https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data/{since}/{language}.json
https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data/{since}/{language}.xml
```

| Parameter | Values |
| --- | --- |
| `since` | `daily`, `weekly`, `monthly` |
| `language` | `all`, or a slug from [`data/languages.json`](data/languages.json): lowercase, spaces become `-` (`c++`, `c#`, `jupyter-notebook`) |

Examples:

```bash
# Today's trending repositories in every language
curl -s https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data/daily/all.json

# This week's trending Rust repositories, as RSS
curl -s https://raw.githubusercontent.com/Rafewm/github-trending-api-managed/main/data/weekly/rust.xml
```

Each JSON file looks like this:

```json
{
  "title": "GitHub All Languages Daily Trending",
  "pubDate": "Tue, 03 Nov 2026 01:39:42 GMT",
  "items": [
    {
      "title": "owner/repo",
      "url": "https://github.com/owner/repo",
      "description": "What the project does",
      "language": "TypeScript",
      "languageColor": "#3178c6",
      "stars": "109,145",
      "forks": "9,559",
      "addStars": "1,527",
      "contributors": [{ "name": "owner", "url": "https://github.com/owner", "avatar": "https://avatars..." }]
    }
  ]
}
```

`stars`, `forks` and `addStars` are formatted strings. `addStars` is the gain within the `since` period.

### Trendshift rows

After the GitHub scrape, [`script/trendshift.js`](script/trendshift.js) reads the live daily, weekly and monthly rankings straight from [trendshift.io](https://trendshift.io) (the page data it serves to its own front end) for `all` and 15 languages (C, C#, C++, Dart, Go, Java, JavaScript, Kotlin, PHP, Python, Ruby, Rust, Swift, TypeScript, Zig). So Trendshift rows are at most 4 hours old.

- Only repos a file does not already list are added, at the end of `items`.
- Added rows carry `"source": "trendshift"` and an empty `contributors` list.
- Each run replaces the previous run's Trendshift rows, so they never pile up or go stale.
- If Trendshift is unreachable, that file keeps its GitHub rows and the run continues.

### Reddit posts

Reddit posts that link a GitHub repo, from [r/BestGitHubRepos](https://www.reddit.com/r/BestGitHubRepos/) and 52 more subreddits (open source, AI and agents, Claude and coding, side projects, three.js, decompilation, Blender; the list is `SUBREDDITS` in [`script/reddit.js`](script/reddit.js)), read from the [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/tree/master/api) Reddit archive.

- [`script/reddit.js`](script/reddit.js), in every data run, reads each subreddit forward from where it last stopped (2 days back, since the archive sometimes saves a post late) into [`data/reddit/BestGitHubRepos.json`](data/reddit/BestGitHubRepos.json). The file kept its first name; each post has `sub`, and `checked` holds where each subreddit was read up to. It saves after every page and stops after 20 minutes; the next run carries on with the subreddits read longest ago.
- [`script/reddit_history.js`](script/reddit_history.js) fills in each added subreddit's year before it was added, into `data/reddit/history/<subreddit>.json`, newest first and always continuing the subreddit with the least history, so every period up to a year fills in evenly. A full year is about 17,000 archive pages (about a day), so [`.github/workflows/reddit_history.yml`](.github/workflows/reddit_history.yml) runs it by hand in 5-hour chunks until the log says every subreddit has its year. It writes only those files, so it never clashes with the data run.
- [`data/reddit/repos.json`](data/reddit/repos.json) holds each linked repo's GitHub details, looked up once and re-checked in rotation, the same way as the Hacker News data (`updateRepos` from `script/hn.js`).
- Every post is read: the archive's text and link searches time out and returned nothing in tests. About 1 in 5 posts are removed by Reddit or moderators before the archive sees them, with no text left, so those repos can't be found.
- The archive records posts shortly after they are made, so upvote counts are not kept.

### Hacker News stories

[`script/hn.js`](script/hn.js) keeps every Hacker News story from the last 366 days that links a GitHub repo, in [`data/hn/stories.json`](data/hn/stories.json), with each repo's GitHub details in [`data/hn/repos.json`](data/hn/repos.json).

- Stories come from the [Algolia HN API](https://hn.algolia.com/api) (`search_by_date`, link contains `github.com`). One search returns at most 1,000 results, so it searches one day at a time and splits any busier window. That finds every story, whatever its points.
- Each story has `objectID`, `title`, `url`, `repo`, `points`, `num_comments` and `created_at_i`. Each run fetches the last 3 days again, since points and comments still change.
- Repo details (`description`, `language`, `stars`, `pushedAt`, `archived`, `topics`) come from GitHub's GraphQL API. Each run looks up new repos, re-checks repos with a story from the last 30 days weekly, and re-checks up to 3,000 of the rest, oldest first. Repos GitHub no longer has are marked `missing`.

### New repositories

[`script/new.js`](script/new.js) keeps every repo made in the last 90 days with 100+ stars, the last year with 300+, or the last 2 years with 500+ (about 28,000) in [`data/new/repos.json`](data/new/repos.json), for the site's New tab. It splits the GitHub search into creation-date slices of under 1,000 results and paces itself to search's 30 requests a minute (about 15 minutes). If a run finds over 20% fewer repos than the last, the file is kept.

### Agent skills

[`script/skills.js`](script/skills.js) collects agent skills, MCP servers and AI agent tools into [`data/skills/skills.json`](data/skills/skills.json), using the same GitHub searches as [AgentSkillsHub](https://github.com/zhuyansen/agent-skills-hub) (topics, names and descriptions such as `mcp-server`, `claude-skill`, `agent-skills`, `openclaw` and `codex`).

- Each entry has `name`, `description`, `language`, `stars`, `topics`, `created`, `pushed`, `avatar` and `type`, most stars first.
- `type` is `mcp`, `claude`, `codex` (Codex and OpenClaw), `agent`, `skill` or `tool`, from keywords in the name, description and topics.
- It runs about every 8 hours (every other Action run), reads up to 1,000 repos per search, and skips forks and archived repos. If most searches fail, the last good file is kept.

### X posts

[`script/twitter_twscrape.py`](script/twitter_twscrape.py) keeps a year of posts from the X accounts in [`data/twitter/accounts.json`](data/twitter/accounts.json) that may name a GitHub repo, in [`data/twitter/tweets.json`](data/twitter/tweets.json), read with [twscrape](https://github.com/vladkens/twscrape) through an X login's cookies. Only those accounts are read: posts from anyone else are not collected.

- Each entry has `id`, `user`, `time` (Unix seconds), `text`, `urls` (expanded links), `likes`, and `conv` for an author's reply under their own post (the post it answers) or `rt` for a repost.
- The author's own replies are read too, since a repo link is often put in the first reply. Replies to other people are skipped.
- A post is kept when it mentions github (also as a broken-up link like `github. com/owner/repo`) or has an `owner/repo` shape outside links, plus the post a kept self-reply answers. The site does the exact matching.
- [`.github/workflows/twitter.yml`](.github/workflows/twitter.yml) runs it hourly (GitHub often starts it hours late) with the `TW_AUTH_TOKEN` and `TW_CT0` secrets. Each run takes the 24 accounts read longest ago (`TW_BATCH`) and reads each back to the newest post seen last time, up to 400 posts (`TW_LIMIT`), so a busy account loses nothing between visits. Account IDs are cached in [`data/twitter/account_ids.json`](data/twitter/account_ids.json), seeded from the X following export (exact IDs come from the banner URL, since the export rounds long ones): looking a username up is the call X keeps refusing, and each refusal stalls a run 15 minutes, so a run tries at most one (`TW_LOOKUPS`). The step is capped at 50 minutes, the script saves after every account, and the commit runs even after a timeout.

### Updating the data

`.github/workflows/run.yml` runs `pnpm build` every 4 hours and on manual dispatch, then `node site/prebuild.mjs`, which builds the site's slow lists into `data/site/`, then commits `data/`. GitHub often starts scheduled runs late, so in practice it runs every 4 to 10 hours. To run it yourself:

```bash
pnpm install
pnpm build                    # GitHub Trending for every language, then Trendshift, Reddit and skills (about 30 minutes)
node site/prebuild.mjs        # The site's slow lists into data/site/ (a few minutes; set GITHUB_TOKEN)
node script/trendshift.js     # Trendshift step only
node script/reddit.js         # Reddit step only (new posts and repo details)
node script/reddit_history.js # Reddit year backfill (REDDIT_RUN_MINUTES caps it)
node script/skills.js         # Skills step only (set GITHUB_TOKEN for the higher search limit)
node script/new.js            # New repos step only (set GITHUB_TOKEN for the higher search limit)
node script/hn.js             # Hacker News step only (needs GITHUB_TOKEN for repo details)
python script/twitter_twscrape.py   # X step only (needs TW_AUTH_TOKEN and TW_CT0; --selftest runs offline checks)
```

---

## Unstarred (`site/`)

A dark, mobile-friendly page modelled on [gitbored.com](https://gitbored.com/)'s browse tab.

**Browse** lists about 700 repositories from this repo's trending data (all languages plus 24 popular ones), with daily, weekly and monthly star growth. You can search, filter by language, minimum stars and topics, and sort by stars or growth.

**New** finds new repositories gaining stars fast with the [GitHub search API](https://docs.github.com/en/rest/search/search#search-repositories), the method [repotrend.com](https://github.com/creatuluw/repotrend.com) uses: repos made in the last 3 days with 50+ stars, 30 days with 100+, 90 days with 100+, a year with 300+, or 2 years with 500+. (90 days to 2 years used to need 1K+, which left out repos released a month or two ago.) One search returns at most 1,000 repos, so the site splits each period into creation-date slices that fit, and lists every match. 90 days, the year and 2 years (about 28,000 repos) come from [`data/new/repos.json`](data/new/repos.json), collected every 4 hours by [`script/new.js`](script/new.js), since building them needs about 450 searches, more than GitHub's 30 a minute allows inside Vercel's 5-minute limit. All time shows the 1,000 most-starred repos with 1K+ stars, since there are about 66,000. GitHub search gives no daily growth, so rows show stars per day since the repo was made, and that is the default sort.

**Skills** lists the agent skills, MCP servers and agent tools from `data/skills/skills.json`, with a **Type** filter (MCP servers, Claude skills, Codex and OpenClaw, agent tools, other skills, other tools). Starred repos are dropped by checking your whole starred list, which is faster than the 50-at-a-time GraphQL check for thousands of repos.

**Twitter** lists repos named in posts from the followed X accounts, for the last 24 hours, 7 or 30 days, or the last year, with the post, its likes and author. A repo counts whether the post links it (`https://github.com/owner/repo`), breaks the link with spaces (`github. com / owner / repo`), or just writes `owner/repo`, in the post, a quoted or reposted post, or the author's first reply. Names that are not real GitHub repos are dropped, and a repo only written as `owner/repo` needs 20 stars, so phrases like "and/or" or "CI/CD" don't show.

**Hacker News** lists GitHub repositories linked from Hacker News stories, through the [Algolia HN search API](https://hn.algolia.com/api), for the last day, week, month, year or all time. Rows show the story title, points, comments and age, with links to the discussion and the repo. Day, week, month and year list every GitHub-linked story from the collected data (`data/hn`), down to 1-point posts. All time adds the 1,000 best-ranked GitHub stories ever, the most one Algolia search returns.

**Releases** combines three sources for the last 24 hours, 7, 14 or 30 days, or the last year: notable new GitHub releases from [releasemonitor.org](https://releasemonitor.org) (up to 500 per period, ranked by Release Monitor, linked to the repo's releases page) posts from r/BestGitHubRepos and 52 more subreddits (linked to the Reddit thread; the last year keeps the 10,000 most-starred repos, every shorter period lists all), and popular repos updated in the period from GitHub search (`stars:>1000 pushed:>=<start of period>`, most stars first, up to 1,000). A **Source** filter shows all of them or one source; choosing GitHub sorts by total stars. A repo found by more than one source appears once with every link. Release Monitor stops at 30 days, so the year shows Reddit posts only. Release Monitor has no real language filter, so the **Primary language** filter uses each repo's main language from GitHub instead.

**Starred repos never appear.** The server checks every repo against your GitHub stars, and also re-checks your 100 newest stars on every page load, so a repo you just starred disappears when you come back to the tab.

**Hide** removes a repo from every list without starring it. The **Hidden** tab lists them with an Unhide button.

**Star** stars the repo on GitHub without leaving the page, through the server and its token, and needs the hide key. The row leaves at once and comes back with an error if GitHub refuses. Starring a repo in the Hidden or Track tab also takes it off that list. The server token needs the Starring permission for this (fine-grained token: Starring read and write; classic token: `public_repo`).

**Track** (the pill in each row's top-right corner) saves a repo for later without starring it: it leaves Browse, New, Skills, Twitter, Hacker News and Releases and is listed only in the **Track** tab. A repo is either hidden or tracked, never both, so the Hidden tab has a Track button and the Track tab a Hide button to move a repo across.

Both lists are JSON files on this repo's [`lists`](../../tree/lists) branch (`lists/hidden.json`, `lists/tracked.json`), so they are the same on every device. Every change is a commit there, so the branch history keeps every past version. Anyone can view them; changing them needs your hide key, which each browser asks for once. Clicks within about a second are saved as one commit. The page loads the lists first, straight from GitHub's file CDN at the exact commit (falling back to `/api/hidden` and `/api/tracked`), shows no repo rows until they arrive, and downloads them again only when their version changes.

### How it works

| Path | Purpose |
| --- | --- |
| `public/` | The page: `index.html`, `app.js`, `style.css`. No build step and no dependencies. |
| `repos.js` | Sends lists in pages of 5,000 repos (`?page=0`, `1`, ... with `more: true` while more remain), since Vercel refuses responses over 4.5 MB; the page joins them. Repos with no stars are left out of every list. Loads trending data, GitHub search results, Hacker News stories and Release Monitor releases, adds GitHub details and drops starred repos (GraphQL `viewerHasStarred`, 50 repos per query, 3 queries at a time with retries, since GitHub refuses large bursts). Every response is also checked against your full starred list, at most a minute old, so a cached list can never show a repo you starred since. |
| `cache.js` | Keeps a list built on the server in the instance's memory; an old list is served while a new one is built in the background. Used only when a prebuilt file is missing or more than 12 hours old. |
| `prebuild.mjs` | Run by the data repo's Action: builds the slow lists (Browse, Releases, Twitter, New 3/30/90 days and all time, the HN all-time top) into `data/site/*.json`, so the site only reads files. Starred repos stay in the files; each response drops them against your full star list. A list that fails keeps its last good file. |
| `hidden.js` | Hidden and tracked list APIs on the `lists` branch, through GitHub's contents API. A write is redone on top of any change made meanwhile. Writes need the `X-Hide-Key` header and every entry is validated. |
| `trending.js` | Pure helpers for merging and filtering, covered by tests. |
| `api/` | Vercel functions for the endpoints below. |
| `server.js` | The same endpoints for running locally. |

| Endpoint | Returns |
| --- | --- |
| `GET /api/repos` | Trending repos you have not starred. Cached 5 minutes. |
| `GET /api/new?period=3\|30\|90\|365\|730\|all` | New repos gaining stars fast that you have not starred, with `created.perDay`. Cached 30 minutes. |
| `GET /api/skills?type=all\|mcp\|claude\|codex\|agent\|skill\|tool` | Agent skills and MCP servers you have not starred. Cached 30 minutes. |
| `GET /api/releases?days=1\|7\|14\|30\|365` | Release Monitor releases, r/BestGitHubRepos posts and popular repos updated in the period (`github: true`), for repos you have not starred, with `failed` naming any source that could not be loaded. Cached 30 minutes. |
| `GET /api/hn?period=day\|week\|month\|year\|all` | Hacker News repos you have not starred. Day to year come from the collected files (kept in memory 10 minutes). All time adds the top 1,000 stories ever, cached an hour. |
| `POST /api/star` | `{"name": "owner/repo"}` stars the repo on GitHub, with the `X-Hide-Key` header. |
| `GET /api/twitter?days=1|7|30|365` | Repos named in posts from followed X accounts that you have not starred, each with its newest `tweet`. Cached 30 minutes. |
| `GET /api/stars` | Your 10 newest stars, uncached, checked when you return to the tab so a repo you just starred leaves at once. |
| `GET /api/hidden`, `GET /api/tracked` | The hidden or tracked list. |
| `GET /api/lists-version` | `{"version"}`, the `lists` branch head. The page checks it on load and focus, and downloads the lists only when it changed. |
| `POST /api/hidden`, `POST /api/tracked` | `{"hide": [repo], "unhide": ["owner/repo"]}` adds or removes repos as one commit, with the `X-Hide-Key` header. Returns `{"version", "count"}`, not the list. |

The GitHub token stays on the server. The Vercel CDN caches responses for 30 seconds so visitors cannot use up the token's GitHub quota.

### Settings

| Variable | Needed for |
| --- | --- |
| `UNSTARRED_TOKEN` | A GitHub token for your account. A fine-grained token with **Contents: read and write** on this repo (for the lists) and the **Starring: read and write** account permission (for the star check and the Star button). |
| `HIDE_KEY` | Any long random string. You type it in the browser before your first Hide or Track. |
| `LISTS_API` | Optional. The GitHub API base for the lists repo; defaults to this repo. The tests point it at a fake. |

### Run locally

Needs Node.js 22.9 or newer.

```bash
cd site
cp .env.example .env          # fill in UNSTARRED_TOKEN and HIDE_KEY
npm start                     # http://localhost:18210
npm test
```

On Windows, `open-unstarred.cmd` starts the server if needed and opens the page; point a desktop shortcut at it.

### Deploy on Vercel

1. Import this repo into Vercel and set the project's **Root Directory** to `site`.
2. Create the `lists` branch if it is missing (any commit holding `lists/hidden.json` and `lists/tracked.json`, each `{}`).
3. Add `UNSTARRED_TOKEN` and `HIDE_KEY` as environment variables.
4. Deploy.

---

## Credits

- Data scraper by [isboyjc/github-trending-api](https://github.com/isboyjc/github-trending-api), via [alvinunreal/github-trending-api-managed](https://github.com/alvinunreal/github-trending-api-managed).
- Extra rankings from [Trendshift.io](https://trendshift.io); reading its page data follows [quantavil/trendshift](https://github.com/quantavil/trendshift).
- The New tab follows [repotrend.com](https://github.com/creatuluw/repotrend.com)'s GitHub search queries.
- The Skills tab uses [AgentSkillsHub](https://github.com/zhuyansen/agent-skills-hub)'s GitHub search queries and categories.
- X posts read with [twscrape](https://github.com/vladkens/twscrape).
- Hacker News data from the [Algolia HN search API](https://hn.algolia.com/api).
- Release data from [Release Monitor](https://releasemonitor.org).
- Reddit posts from r/BestGitHubRepos and other subreddits via [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift).

## License

MIT, see [LICENSE](LICENSE).
