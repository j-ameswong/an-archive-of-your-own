# An Archive Of Your Own

A personal, offline browser for a private AO3 reading list. It tracks what you
have read, abandoned, are partway through, or are caught up on while the author
keeps posting — the thing AO3's own bookmarks do not do.

Paste a work or series link and it is fetched, parsed and stored. Paste a
*chapter* link and it also records where you stopped. A small Node HTTP server
reads a local SQLite database and serves a single-page frontend for searching,
filtering and skimming what you have saved.

![The list view: status filters with counts, and cards showing reading progress](docs/img/list.png)

No dependencies, no build step, no framework — Node's standard library and
SQLite. About 2,300 lines of server, schema and frontend, and 1,400 of tests.

## Status

**Complete and retired.** This was built as a prototype to answer a handful of
design questions before a larger, multi-site project was scoped. It works, it
is tested, and it is no longer being developed.

What it set out to establish, and did:

- **Reading state is derivable.** How far into a fic a pasted link points is
  enough to classify it, without the reader ever picking from a menu. The five
  statuses and the rule that produces them are in [ADR-0003](docs/decisions/0003-derive-reading-status-from-the-pasted-chapter-link.md).
- **Scraping AO3 directly is viable and survivable.** No third-party API, one
  request at a time, and a parser that fails loudly rather than blanking a row
  when the markup moves. See [ADR-0001](docs/decisions/0001-scrape-ao3-directly.md).
- **Upstream facts and the reader's own marks must not share a write path.**
  A re-import refreshes the metadata and cannot touch a note, a favourite, or a
  status the reader set by hand. That separation is the schema's whole point.

See [What I would do differently](#what-i-would-do-differently) for the parts
that would not survive a rewrite.

## Quick start

Requires Node.js 24+ — it uses `node:sqlite`, `node:test` and
`--env-file-if-exists`, all of which land in 24. Developed on 26.

```sh
sqlite3 db/ao3.sqlite3 < db/schema.sql   # a fresh, empty archive
npm start                                # http://localhost:4173
npm test                                 # 101 tests, no network
```

Then open the app, click **Import**, and paste an AO3 link.

`npm start` loads a root `.env` if one is present. Without `AO3_SESSION` the
app works fine; only works whose authors restricted them to logged-in users
will fail to fetch.

## Configuration

Copy `.env.example` to `.env`. It is gitignored, because `AO3_SESSION` is a
live credential.

| Variable | Purpose |
|---|---|
| `AO3_SESSION` | `_otwarchive_session` cookie from a logged-in AO3 session. Without it, works their authors restricted to logged-in users cannot be fetched. See [ADR-0002](docs/decisions/0002-authenticate-with-an-ao3-session-cookie.md). |
| `ARCHIVE_CONTACT` | Contact address, sent in the `User-Agent`. AO3 asks automated clients to be contactable. |
| `AO3_MIN_INTERVAL_MS` | Milliseconds between AO3 requests, default 5000. `npm test` sets it to 0. |
| `HOST` | Interface to bind, default `127.0.0.1` — this machine only. |
| `PORT` | HTTP port, default 4173. |
| `DB_PATH` | Database file, default `db/ao3.sqlite3`. |

`.env` is read at process start, so replacing an expired `AO3_SESSION` needs a
restart. A login redirect while a cookie is set is reported as
`expired_session`, distinguishing a dead cookie from a genuinely restricted
work.

AO3 renders timestamps in the logged-in account's timezone. Keep the account
behind `AO3_SESSION` set to UTC, or `published_at` and `updated_at` will land a
day off the rest of the database.

## Getting a database

`db/*.sqlite3` is gitignored, so a fresh clone has no data. `db/schema.sql` is
the schema of record:

```sh
sqlite3 db/ao3.sqlite3 < db/schema.sql
```

An older database is brought up to it by applying each migration in order, once:

| File | Adds |
|---|---|
| `db/migrate_001.sql` | `enriched_at`, `fetch_status`, `fetch_error`, and an `fic_fts` that can be re-indexed in place |
| `db/migrate_002.sql` | the `caught_up` reading status |
| `db/migrate_003.sql` | a reading position on fics already marked read |

```sh
sqlite3 db/ao3.sqlite3 < db/migrate_001.sql
sqlite3 db/ao3.sqlite3 < db/migrate_002.sql
sqlite3 db/ao3.sqlite3 < db/migrate_003.sql
```

`migrate_002.sql` rebuilds `fic`, since SQLite cannot widen a `CHECK`
constraint in place. Back the database up before applying it. `migrate_003.sql`
writes `chapter` on rows already marked `read` or `caught_up`, which is the
position those statuses assert; it changes nothing else and is safe to re-run.

## Data model

`db/schema.sql` — two tables and a search index.

**`fic`** — one row per AO3 work or series (`kind`), keyed by `slug`. Columns
fall into four groups, and which group a column is in decides who may write it:

- *Upstream facts* (`title`, `author`, `word_count`, `chapters_done/total`,
  `rating`, `kudos`, `bookmarks`, timestamps) — refreshed on import.
- *Curation* (`note`, `favourite`) — the reader's own, never re-derived, so a
  re-import cannot clobber it.
- *Reading state* (`status`, `chapter`, `resume_url`, `last_read_at`,
  `state_source`) — this database is the system of record. `status` is one of
  `to_read`, `unfinished`, `caught_up`, `read`, `dropped`. `state_source` is
  `import` where the status was derived from a chapter number and `user` where
  the reader set it by hand.
- *Enrichment bookkeeping* (`enriched_at`, `fetch_status`, `fetch_error`) — when
  the upstream facts were last refreshed, and why the last attempt failed.
  `fetch_status` is `ok`, `restricted`, `missing` or `error`; `NULL` means never
  fetched.

**`fic_tag`** — `(fic_id, tag_type, tag)`, where `tag_type` is one of `fandom`,
`relationship`, `character`, `freeform`, `category`, `warning`, `genre`.

**`fic_fts`** — an FTS5 index over `title`, `author`, `summary`, `tags`. It is
contentless (`content=''`) with `contentless_delete=1`, so a row can be
re-indexed with `DELETE FROM fic_fts WHERE rowid = ?`. It has **no triggers**:
rows must be written with `rowid` set to `fic.id`, which is what the search query
joins on. A note is curation, not upstream text, and is deliberately not indexed.

`db/archive_schema.sql` is an earlier, multi-site schema, kept as the record of
what this narrowed down from. Nothing in `server/` reads it. See
[docs/history.md](docs/history.md).

## Reading status

An import derives `status` from how far into the fic the pasted link points.
Paste a chapter deep link and it is read as where you stopped; paste a bare work
link and it carries no position at all.

| Where the link points | `status` |
|---|---|
| nowhere — a bare work or series link | `to_read` |
| the first chapter | `to_read` |
| past the first chapter, short of the last posted one | `unfinished` |
| the last posted chapter, author still writing | `caught_up` |
| the last posted chapter, author marked it finished | `read` |

Chapter 1 counts as opened rather than started, so a one-chapter work is never
finished automatically. `dropped` is never derived.

The same rule runs on a chapter edited by hand. `PATCH /api/fics/:id` takes a
`chapter`, a `status`, or both:

- A **chapter** is a position. It re-derives the status and leaves
  `state_source = 'import'`, so a later refresh may move the status again.
- A **status** is a verdict. It pins the status and sets
  `state_source = 'user'`, which stops a later import re-deriving it.
- Sending both writes the chapter and pins the status given.

A hand-set chapter clears `resume_url`. That link is built from AO3's chapter
id, which a chapter number cannot reconstruct, so the detail panel falls back
from *Continue Reading* to *Open on AO3*. Importing a chapter deep link is still
the way to get one. Setting a chapter also stamps `last_read_at`; clearing it
does not.

Cards and the detail panel show that position as `chapter/chapters_done` — how
far the reader is through what exists. `chapters_total` is the author's plan and
is not shown; a `+` on the denominator marks a work they have not finished, so
`7/11+` reads as chapter 7 of at least 11. A fic with no chapters at all, which
is every series, shows no pill.

See [ADR-0003](docs/decisions/0003-derive-reading-status-from-the-pasted-chapter-link.md).

## Import

Metadata comes from AO3 work and series pages, fetched and parsed directly
rather than through a third-party API — see
[ADR-0001](docs/decisions/0001-scrape-ao3-directly.md).

`server/import.js` provides:

- `normalizeUrl(input)` → `{ kind, slug, url, chapter_id }`, or `null` for
  anything that is not an AO3 work or series link. Chapter deep links,
  `?view_adult=true`, fragments, collection-scoped paths and bare hostnames all
  collapse onto one `slug`; a chapter deep link also yields `chapter_id`, which
  is AO3's global chapter id and says nothing about position on its own.
- `fetchAo3(url)` → `{ status: 'ok', html, url }`, or a status of `restricted`,
  `expired_session`, `missing` or `error`. Requests run one at a time, five
  seconds apart; 429 and 5xx are retried with backoff, honouring `Retry-After`.

`server/parse.js` turns a fetched page into a row:

- `parseWork(html)` and `parseSeries(html)` → the `fic` columns plus `tags`
  grouped by type. They read only the metadata block at the top of a page and
  throw if it is absent, so an upstream markup change surfaces as an error
  rather than blanking a row.
- A work is `is_complete` when every chapter its author promised is posted.
  AO3 omits its "Completed:"/"Updated:" row when a work was finished the day it
  was posted, so the chapter counts decide, not the label.
- `chapter_ids` carries the page's chapter menu in order, which is what turns a
  `chapter_id` into a chapter number. A one-chapter work has no menu.
- Series pages state no rating, kudos, chapter counts or full tag lists; those
  come back `null` or empty.

`server/store.js` writes the result:

- `upsertFic(db, target, record)` inserts or refreshes a fic, its tags and its
  search index entry in one transaction. `note` and `favourite` survive a
  re-import untouched.
- Reading state is written only when the link names a chapter. That sets
  `chapter` and `resume_url`, and re-derives `status` where
  `state_source = 'import'`; a status the reader set by hand is left alone. A
  link with no chapter changes no reading state at all.
- `deriveStatus({ chapter, chapters_done, is_complete })` is the rule above, on
  its own.
- `applyReadingState(db, id, { status, chapter })` is the hand-edit path behind
  `PATCH /api/fics/:id`, and enforces the same rule.
- `setCuration(db, id, { favourite, note })` is the other hand-edit path. It is
  the only thing that writes those two columns; a blank note is stored as
  `NULL`, so "no note" has one representation.
- `recordFetchFailure(db, slug, status, error)` records a `restricted`,
  `missing` or `error` outcome against a fic already stored, leaving its facts
  in place. A pasted URL that cannot be fetched is reported to the caller rather
  than left behind as an empty row.

`POST /api/import` ties these together, and the frontend's **Import** box calls
it; see the API table below.

The server opens the database read-write, so a database browser left open on
`db/ao3.sqlite3` can block an import. Imports wait 5 seconds for the lock and
then answer `locked` rather than hanging.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/fics` | `{ items, total, limit, offset }` — each item carries its `fandoms` array |
| `GET /api/fics/:id` | one fic with `tags` grouped by type |
| `GET /api/meta` | per-`status` counts |
| `POST /api/import` | `{ url }` → `{ fic, created }`. `201` when the fic is new, `200` when it was already stored. |
| `PATCH /api/fics/:id` | `{ status?, chapter?, favourite?, note? }` → the updated fic. At least one required. |

`PATCH` carries two independent concerns. `status` and `chapter` are reading
state and follow the rules above; `favourite` (a boolean) and `note` (a string,
or `null` to clear) are curation and move nothing else. A request body is capped
at 4 KB, which is also the cap on a note.

A failed request answers with `{ error, message }` so the cause is actionable:

| `error` | HTTP | Meaning |
|---|---|---|
| `bad_body` | 400 | body was not valid JSON |
| `bad_url` | 400 | not an AO3 work or series link |
| `bad_status` | 400 | not one of the five reading statuses |
| `bad_chapter` | 400 | not a whole chapter number this fic has, or a chapter on a series |
| `bad_favourite` | 400 | not `true` or `false` |
| `bad_note` | 400 | not a string or `null` |
| `empty_patch` | 400 | none of the four fields was sent |
| `expired_session` | 401 | `AO3_SESSION` no longer works; replace it and restart |
| `restricted` | 403 | logged-in only, and no `AO3_SESSION` is set |
| `missing` | 404 | AO3 has no such work; it may have been deleted |
| `locked` | 503 | another program holds the database write lock |
| `error` / `unparseable` | 502 | AO3 unreachable, or its page could not be read |

A rejected `PATCH` is validated in full before anything is written, so the valid
half of an invalid patch does not land either.

For a fic already stored, a `restricted`, `missing` or `error` outcome is also
written to its `fetch_status` and `fetch_error`. A url that has never been
imported leaves no row behind.

`/api/fics` query parameters:

- `q` — full-text search. Input is reduced to letter/digit runs, each quoted and
  given a trailing `*`, then ANDed, so arbitrary user text can never be an FTS5
  syntax error. Punctuation-only input matches nothing.
- `status` — comma-separated list (OR within the list)
- `favourite=1`
- `sort` — `updated_at` (default), `published_at`, `word_count`, `kudos`,
  `title`; `dir` — `desc` (default) or `asc`. NULLs sort last.
- `limit` (1–100, default 30), `offset`

## Frontend

`public/` — plain HTML, CSS and one script, no framework.

![The detail dialog: reading status, chapter reached, favourite and note](docs/img/detail.png)

- **Import** in the header opens a URL box: paste an AO3 work or series link and
  it is fetched, saved and opened. The form locks while in flight, since a cold
  fetch from AO3 takes seconds and imports run one at a time server-side.
  Failures are shown in place with the reason
- Search box (debounced 300ms), status chips with counts, favourites toggle,
  sort select
- Each card carries a reading-progress pill, `7/11+ ch`, rather than the
  author's chapter plan
- Cursor-free pagination via **Load more**; the offset tracks what actually
  rendered, so a failed or superseded page can't leave a gap
- Filters are mirrored into the query string with `replaceState`, so a filtered
  view is linkable and survives reload without eating the Back button
- Clicking a card opens a detail dialog with full tags, summary and a link
  to `resume_url` (*Continue Reading*) or `url`
- The dialog's **Reading status** select overrides the derived status, and
  **Chapter reached** sets the position and lets the status follow from it. The
  chapter box is shown only for multi-chapter works
- **Favourite** and **Note** are curation, and save on their own. A note saves
  on blur and does not rebuild the list, which has nothing to show for it; a
  favourite does, because the star is on the cards and drives a filter
- Every edit repaints the panel from the server's response rather than from a
  second copy of the derivation rules in the browser. A failed save puts the
  control back and says so, leaving the row as it was
- The open dialog owns a history entry, so Back dismisses it; focus is trapped
  and restored, and a live region announces the result count

Both list and detail requests are sequence-numbered, so a slow response that lost
the race is discarded rather than overwriting fresher results.

## Tests

```sh
npm test
```

101 tests, `node:test`, no network and no fixtures downloaded at run time.

| File | Covers |
|---|---|
| `server/app.test.js` | the HTTP layer, over a real socket against an in-memory database: filtering, search, sort, paging, `PATCH` validation, error codes, static serving |
| `server/store.test.js` | the write rules — what a re-import may and may not touch, status derivation, curation |
| `server/parse.test.js` | parsing, against real AO3 pages captured in `server/fixtures/` |
| `server/fetch.test.js` | rate limiting, retries, `Retry-After`, and the restricted/expired/missing outcomes |
| `server/import.test.js` | url normalisation |

The parser tests run against six captured AO3 pages, trimmed so no story text is
stored in the repository — see [`server/fixtures/README.md`](server/fixtures/README.md).

## Layout

```
server/server.js   process bootstrap: opens the database and the access log
server/app.js      HTTP routing, request validation, SQLite queries
server/import.js   AO3 url normalisation and fetching
server/parse.js    AO3 work and series page parsing
server/store.js    writing a parsed page back to the database
server/fixtures/   captured AO3 pages used by the parser tests
server/*.test.js   node:test suites
public/            index.html, app.js, style.css
db/schema.sql      schema of record
db/migrate_00*.sql upgrade paths, applied in order
docs/decisions/    architecture decision records
docs/history.md    artefacts kept in the repository but not wired up
docs/img/          screenshots used by this README
```

## What I would do differently

Honest notes, written at the point this was retired.

- **`fic_fts` is kept in sync by hand.** `store.js` re-indexes a row on every
  upsert, and nothing enforces that it happened. SQLite triggers would make the
  index impossible to forget; the contentless table was chosen first and the
  consequence only became clear later.
- **Nothing ever refreshes a stale row.** `enriched_at` is written on every
  import and never read. Re-importing is the only way to pick up new chapters,
  which is fine for one reader and would not be for a library.
- **`PATCH` does two writes, not one transaction.** Reading state and curation
  are written separately. Both are validated up front, so a rejected patch
  writes nothing, but a crash between the two would still be a torn update.
  A single statement, or a transaction, is the right answer.
- **`fetch_status` still allows `'fichub'`,** a value nothing writes. SQLite
  cannot narrow a `CHECK` without rebuilding the table, so it stayed rather than
  earning a fourth migration for cosmetics.
- **The path-traversal guard in `serveStatic` is unreachable.** The WHATWG URL
  parser resolves every dot segment, `%2e%2e` included, before a pathname
  reaches it. The check is harmless defence in depth, but it is not what makes
  static serving safe, and a reader could easily believe it is.
- **Scraping is a standing liability.** The parser throws rather than writing
  blanks when AO3's markup moves, which is the right failure, but it is still a
  failure that arrives without warning. The fixtures pin today's markup, not
  tomorrow's.

## Licence

[MIT](LICENSE).

Not affiliated with, or endorsed by, the Archive Of Our Own or the
Organization for Transformative Works. It reads public pages, one request every
five seconds, with a contactable `User-Agent` — please keep it that way.
