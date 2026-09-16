# Decision: take fic metadata by scraping AO3 directly

## Context

`fic` rows carry upstream facts — title, author, summary, rating, word and
chapter counts, kudos, bookmarks, timestamps — plus tags in `fic_tag`. Import
and scheduled enrichment both need a source for those facts, for AO3 works and
AO3 series alike.

## Decision

Fetch and parse AO3 work and series pages directly. `server/import.js` holds the
fetcher; parsing is scoped to the `<dl class="work meta group">` and
`<dl class="series meta group">` blocks.

## Alternatives

The [fichub.net API](https://fichub.net/api) was measured against live AO3 and
against the existing database, and rejected.

## Rationale

fichub serves cached metadata and does not refresh it on request. Two works
sampled from the database:

| Work | Field | fichub | Live AO3 |
|---|---|---|---|
| `works/15649041` | chapters | 38/38 | 45/45 |
| | words | 137,175 | 155,581 |
| | kudos | 9,177 | 10,450 |
| | updated | 2024-03-09 | 2024-05-23 |
| `works/31744579` | kudos | 3,036 | 4,813 |

The first was reported complete at 38/38 while AO3 showed 45/45 — the wrong
answer to "is there more to read?", which is what this archive exists to track.
Requesting the same URL again two minutes later returned identical stale data,
so repeat calls do not force a refresh.

Further findings:

- Series are unsupported: a `/series/{id}` query returns `err: -1`.
- Tags live in `rawExtendedMeta`, which was `null` for two of eight sampled
  works, and whose key set varies with the age of fichub's cached scrape.
- `/api/v0/meta` delegates to `/api/v0/epub`, so an uncached fic triggers a full
  multi-chapter export; cold requests took 52–90 seconds.
- The existing database already matched live AO3, so importing via fichub would
  have regressed data rather than enriched it.

AO3's `robots.txt` permits `/works/{id}` and `/series/{id}` for all user agents,
and sets no crawl delay for them.

## Consequences

- The project owns the HTML parsing, which is brittle against AO3 markup
  changes. A parse that cannot find the meta block records `fetch_error` rather
  than writing nulls over good data.
- The project must pace itself: requests run one at a time, five seconds apart.
- AO3 can fail transiently — a `525` was observed — so 429 and 5xx responses are
  retried with backoff, honouring `Retry-After`.
- `fic.fetch_status` still admits the value `'fichub'`, from when a fallback was
  planned. It is unused. SQLite cannot narrow a `CHECK` constraint without
  rebuilding the table, so the value stays.
