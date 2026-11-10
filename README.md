# GitHub Trending API + Unstarred

Two things live in this repo:

1. **A trending data API.** A GitHub Action scrapes [GitHub Trending](https://github.com/trending) every 4 hours, adds the live [Trendshift](https://trendshift.io) rankings, and commits the results as static JSON and RSS files under [`data/`](data).
2. **Unstarred**, a website in [`site/`](site) for browsing that data, GitHub projects on Hacker News and notable new releases, with every repo you have already starred filtered out.

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

### Updating the data

`.github/workflows/run.yml` runs `pnpm build` every 4 hours and on manual dispatch, then commits `data/`. To run it yourself:

```bash
pnpm install
pnpm build                    # GitHub Trending for every language, then Trendshift (about 30 minutes)
node script/trendshift.js     # Trendshift step only
```

---

## Unstarred (`site/`)

A dark, mobile-friendly page modelled on [gitbored.com](https://gitbored.com/)'s browse tab.

**Browse** lists about 700 repositories from this repo's trending data (all languages plus 24 popular ones), with daily, weekly and monthly star growth. You can search, filter by language, minimum stars and topics, and sort by stars or growth.

**Hacker News** lists GitHub repositories linked from Hacker News stories, through the [Algolia HN search API](https://hn.algolia.com/api), for the last day, week, month, year or all time. Rows show the story title, points, comments and age, with links to the discussion and the repo. Each period holds at most the 1,000 highest-scoring stories, which is the API's limit.

**Releases** lists notable new GitHub releases from [releasemonitor.org](https://releasemonitor.org) for the last 24 hours, 7, 14 or 30 days (up to 500 per period, ranked by Release Monitor), with a link to each repo's releases page. Release Monitor has no real language filter, so the **Primary language** filter uses each repo's main language from GitHub instead.

**Starred repos never appear.** The server checks every repo against your GitHub stars, and also re-checks your 100 newest stars on every page load, so a repo you just starred disappears when you come back to the tab.

**Hide** removes a repo from every list without starring it. The **Hidden** tab lists them with an Unhide button.

**Track** (the pill in each row's top-right corner) saves a repo for later without starring it: it leaves Browse and Hacker News and is listed only in the **Track** tab. A repo is either hidden or tracked, never both, so the Hidden tab has a Track button and the Track tab a Hide button to move a repo across.

Both lists are stored in Upstash Redis, so they are the same on every device. Anyone can view them; changing them needs your hide key, which each browser asks for once.

### How it works

| Path | Purpose |
| --- | --- |
| `public/` | The page: `index.html`, `app.js`, `style.css`. No build step and no dependencies. |
| `repos.js` | Loads trending data, Hacker News stories and Release Monitor releases, adds GitHub details and drops starred repos (GraphQL `viewerHasStarred`, 50 repos per query, 3 queries at a time with retries, since GitHub refuses large bursts). |
| `hidden.js` | Hidden and tracked list APIs on Upstash Redis's REST API. Writes need the `X-Hide-Key` header and every entry is validated. |
| `trending.js` | Pure helpers for merging and filtering, covered by tests. |
| `api/` | Vercel functions for the endpoints below. |
| `server.js` | The same endpoints for running locally. |

| Endpoint | Returns |
| --- | --- |
| `GET /api/repos` | Trending repos you have not starred. Cached 5 minutes. |
| `GET /api/releases?days=1\|7\|14\|30` | Release Monitor releases for repos you have not starred. Cached 30 minutes. |
| `GET /api/hn?period=day\|week\|month\|year\|all` | Hacker News repos you have not starred. Day and week are cached 5 minutes, the rest for an hour. |
| `GET /api/hidden`, `GET /api/tracked` | The hidden or tracked list. |
| `POST /api/hidden`, `POST /api/tracked` | `{"hide": [repo], "unhide": ["owner/repo"]}` adds or removes repos, with the `X-Hide-Key` header. Returns the new list. |

The GitHub token stays on the server. The Vercel CDN caches responses for 30 seconds so visitors cannot use up the token's GitHub quota.

### Settings

| Variable | Needed for |
| --- | --- |
| `UNSTARRED_TOKEN` | A GitHub token for your account. A classic token with **no scopes** is enough. |
| `HIDE_KEY` | Any long random string. You type it in the browser before your first Hide or Track. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis for the hidden and tracked lists. Without them, hiding falls back to the browser's own storage and Track does not work. |

### Run locally

Needs Node.js 22.9 or newer.

```bash
cd site
cp .env.example .env          # fill in UNSTARRED_TOKEN and HIDE_KEY
npm start                     # http://localhost:3210
npm test
```

On Windows, `open-unstarred.cmd` starts the server if needed and opens the page; point a desktop shortcut at it.

### Deploy on Vercel

1. Import this repo into Vercel and set the project's **Root Directory** to `site`.
2. In the project's Storage tab, connect **Upstash for Redis** (free plan). It adds the `KV_*` variables.
3. Add `UNSTARRED_TOKEN` and `HIDE_KEY` as environment variables.
4. Deploy. For local runs, `vercel env pull .env.local` copies the Redis settings down.

---

## Credits

- Data scraper by [isboyjc/github-trending-api](https://github.com/isboyjc/github-trending-api), via [alvinunreal/github-trending-api-managed](https://github.com/alvinunreal/github-trending-api-managed).
- Extra rankings from [Trendshift.io](https://trendshift.io); reading its page data follows [quantavil/trendshift](https://github.com/quantavil/trendshift).
- Hacker News data from the [Algolia HN search API](https://hn.algolia.com/api).
- Release data from [Release Monitor](https://releasemonitor.org).

## License

MIT, see [LICENSE](LICENSE).
