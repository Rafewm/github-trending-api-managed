"""Collect recent posts from the X accounts in data/twitter/accounts.json with twscrape (cookie auth),
keeping only those that may name a GitHub repo, and save data/twitter/tweets.json for the site to parse.

Replaces the twitterapi.io collector (old script/twitter.js). Same output shape and filtering, so the
site needs no change:  {updated, readUntil: {user: unixtime}, tweets: [{id,user,time,text,urls,likes,conv?,rt?}]}.
readUntil is the per-user incremental cursor; a run only fetches posts newer than it.

Runs in batches so one cookie account doesn't hit X's rate limit: each run takes the TW_BATCH accounts
whose readUntil is oldest (default 8), so an hourly schedule rotates through all 47 in a few hours and
keeps refreshing. The author's own replies under their posts are kept too (links often go in the first reply).

Env:  TW_AUTH_TOKEN, TW_CT0 (the X session cookies; set as GitHub Actions secrets).
      TW_BATCH accounts per run (default 8), TW_LIMIT tweets per account (default 40).
Usage:  python script/twitter_twscrape.py            # one batch
        python script/twitter_twscrape.py elonmusk   # specific accounts (ignores batching)
        python script/twitter_twscrape.py --selftest  # offline checks, no network
"""
import asyncio
import json
import os
import re
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", "data", "twitter")
ACCOUNTS = os.path.join(DIR, "accounts.json")
FILE = os.path.join(DIR, "tweets.json")
KEEP_SECONDS = 365 * 86400
BATCH = int(os.environ.get("TW_BATCH", "8"))
LIMIT = int(os.environ.get("TW_LIMIT", "40"))

# Mirror of script/twitter.js: a loose test; the site does the strict one. "github" anywhere (links,
# spaced links), or an owner/repo shape in the text once links are cut out.
OWNER_REPO = re.compile(r"(?<![\w./:@#-])[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+")
STRIP_URLS = re.compile(r"\b(?:https?://|www\.)\S+", re.I)


def maybe_repo(entry: dict) -> bool:
    blob = f"{entry['text']} {' '.join(entry['urls'])}"
    if "github" in blob.lower():
        return True
    return bool(OWNER_REPO.search(STRIP_URLS.sub(" ", entry["text"])))


def shape(t, user: str) -> dict:
    """twscrape Tweet -> the stored entry, matching the old collector's fields."""
    inner = getattr(t, "retweetedTweet", None) or getattr(t, "quotedTweet", None)
    urls = []
    for x in (t, inner):
        if x:
            urls += [l.url for l in (getattr(x, "links", None) or []) if getattr(l, "url", None)]
    rt = getattr(t, "retweetedTweet", None)
    if rt:
        text = rt.rawContent or ""
    else:
        q = getattr(t, "quotedTweet", None)
        text = (t.rawContent or "") + (f" {q.rawContent or ''}" if q else "")
    reply_to = getattr(t, "inReplyToUser", None)
    self_reply = bool(reply_to and (reply_to.username or "").lower() == user.lower())
    entry = {
        "id": str(t.id),
        "user": (t.user.username if t.user else user),
        "time": int(t.date.timestamp()) if t.date else 0,
        "text": text,
        "urls": urls,
        "likes": t.likeCount or 0,
    }
    cid = str(getattr(t, "conversationId", "") or "")
    if self_reply and cid and cid != str(t.id):
        entry["conv"] = cid
    if rt and rt.user:
        entry["rt"] = rt.user.username
    return entry


def pick_accounts(accounts: list[str], read_until: dict) -> list[str]:
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        return sys.argv[1:]
    return sorted(accounts, key=lambda u: read_until.get(u, 0))[:BATCH]


async def main():
    from twscrape import API, gather

    saved = json.load(open(FILE, encoding="utf-8")) if os.path.exists(FILE) else {"tweets": [], "readUntil": {}}
    by_id = {t["id"]: t for t in saved.get("tweets", [])}
    read_until = dict(saved.get("readUntil", {}))
    accounts = json.load(open(ACCOUNTS, encoding="utf-8"))
    cutoff = int(__import__("time").time()) - KEEP_SECONDS

    api = API(os.path.join(DIR, "twscrape_accounts.db"))
    cookies = f"auth_token={os.environ['TW_AUTH_TOKEN']}; ct0={os.environ['TW_CT0']}"
    await api.pool.add_account("cookie_user", "x", "x@x.x", "x", cookies=cookies)
    await api.pool.set_active("cookie_user", True)

    batch = pick_accounts(accounts, read_until)
    print(f"batch of {len(batch)}: {', '.join(batch)}")
    added = 0
    for user in batch:
        try:
            u = await api.user_by_login(user)
            if not u:
                print(f"  @{user}: not resolved"); continue
            raw = await gather(api.user_tweets_and_replies(u.id, limit=LIMIT))
            # Author's own threads only (replies to other people are mostly chat).
            raw = [t for t in raw if not getattr(t, "inReplyToUser", None)
                   or (t.inReplyToUser.username or "").lower() == user.lower()]
            pool = {str(t.id): shape(t, user) for t in raw}
            until = read_until.get(user, 0)
            for t in raw:
                e = pool[str(t.id)]
                if e["id"] in by_id or e["time"] <= until or not maybe_repo(e):
                    continue
                by_id[e["id"]] = e
                added += 1
                root = pool.get(e.get("conv", ""))
                if root and root["id"] not in by_id:
                    by_id[root["id"]] = root
            if pool:
                read_until[user] = max([until] + [e["time"] for e in pool.values()])
            print(f"  @{user}: read {len(raw)}, kept {len(by_id)}")
        except Exception as ex:
            print(f"  @{user}: error {type(ex).__name__}: {ex}")

    tweets = sorted((t for t in by_id.values() if t["time"] >= cutoff), key=lambda t: t["time"], reverse=True)
    os.makedirs(DIR, exist_ok=True)
    with open(FILE, "w", encoding="utf-8") as f:
        from datetime import datetime, timezone
        json.dump({"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                   "readUntil": read_until, "tweets": tweets}, f, ensure_ascii=False)
    print(f"+{added} this run; {len(tweets)} posts kept -> {FILE}")


def selftest():
    keep = {"text": "try ruvnet/metaharness", "urls": []}
    gh = {"text": "see github . com / a / b", "urls": ["https://github.com/a/b"]}
    # Links are stripped before the owner/repo test, so a plain link path is not mistaken for a repo.
    url_only = {"text": "my new post is live https://example.com/a/b", "urls": ["https://example.com/a/b"]}
    plain = {"text": "just some words here", "urls": []}
    assert maybe_repo(keep), "bare owner/repo should match"
    assert maybe_repo(gh), "spaced github link should match"
    assert not maybe_repo(url_only), "stripped url path should not match"
    assert not maybe_repo(plain), "plain text should not match"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        asyncio.run(main())
