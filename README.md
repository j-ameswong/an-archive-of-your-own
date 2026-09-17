# An Archive Of Your Own

A personal, offline browser for a private AO3 reading list. You can track what
you've read, abandoned, are partway through, or are caught up on while the
author keeps posting. A small Node HTTP server reads a local SQLite database
and serves a single-page frontend for searching, filtering and skimming saved
works and series.

## Requirements

- Node.js 24+ (built-in `node:sqlite`, `node:test` and `--env-file-if-exists`)
- A populated `db/ao3.sqlite3`

No dependencies, no build step.

## Running

```sh
npm start              # http://localhost:4173
PORT=8080 npm start    # or pick a port
npm test
```

The server opens the database read-write: `POST /api/import` and
`PATCH /api/fics/:id` write. Favourites and notes are edited directly in the
database.

## Configuration

`npm start` loads a root `.env` if one is present. It is gitignored.

| Variable | Purpose |
|---|---|
| `AO3_SESSION` | `_otwarchive_session` cookie from a logged-in AO3 session. Without it, works their authors restricted to logged-in users cannot be fetched. See [ADR-0002](docs/decisions/0002-authenticate-with-an-ao3-session-cookie.md). |
| `ARCHIVE_CONTACT` | Contact address, sent in the `User-Agent`. AO3 asks automated clients to be contactable. |
| `PORT` | HTTP port, default 4173. |
| `HOST` | Interface to bind, default `127.0.0.1` (this machine only)
| `AO3_MIN_INTERVAL_MS` | Milliseconds between AO3 requests, default 5000. `npm test` sets it to 0. |

`.env` is read at process start, so replacing an expired `AO3_SESSION` needs a
restart. A login redirect while a cookie is set is reported as
`expired_session`, distinguishing a dead cookie from a genuinely restricted
work.

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

```sh
sqlite3 db/ao3.sqlite3 < db/migrate_001.sql
sqlite3 db/ao3.sqlite3 < db/migrate_002.sql
```

`migrate_002.sql` rebuilds `fic`, since SQLite cannot widen a `CHECK`
constraint in place. Back the database up before applying it.

Rows are loaded into `fic`, `fic_tag` and `fic_fts` by hand; `fic_fts` has no
sync triggers.

## Data model

`db/schema.sql` — two tables and a search index.

**`fic`** — one row per AO3 work or series (`kind`), keyed by `slug`. Columns
fall into four groups:

- *Upstream facts* (`title`, `author`, `word_count`, `chapters_done/total`,
  `rating`, `kudos`, `bookmarks`, timestamps) — refreshed on import.
- *Curation* (`note`, `favourite`) — set by hand, never re-derived, so a
  re-import can't clobber it.
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
joins on.

`db/archive_schema.sql` and `db/archive.sqlite3` are unused; nothing in
`server/` reads them. See [docs/history.md](docs/history.md).

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

`PATCH /api/fics/:id` overrides the derived value and sets
`state_source = 'user'`, which stops a later import re-deriving it. See
[ADR-0003](docs/decisions/0003-derive-reading-status-from-the-pasted-chapter-link.md).

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
- `recordFetchFailure(db, slug, status, error)` records a `restricted`,
  `missing` or `error` outcome against a fic already stored, leaving its facts
  in place. A pasted URL that cannot be fetched is reported to the caller rather
  than left behind as an empty row.

`POST /api/import` ties these together, and the frontend's **Import** box calls
it; see the API table below.

The server opens the database read-write, so a database browser left open on
`db/ao3.sqlite3` can block an import. Imports wait 5 seconds for the lock and
then answer `locked` rather than hanging.

AO3 renders timestamps in the logged-in account's timezone. Keep the account
behind `AO3_SESSION` set to UTC, or `published_at` and `updated_at` will land a
day off the rest of the database.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/fics` | `{ items, total, limit, offset }` — each item carries its `fandoms` array |
| `GET /api/fics/:id` | one fic with `tags` grouped by type |
| `GET /api/meta` | per-`status` counts |
| `POST /api/import` | `{ url }` → `{ fic, created }`. `201` when the fic is new, `200` when it was already stored. |
| `PATCH /api/fics/:id` | `{ status }` → the updated fic. Sets `state_source = 'user'`. |

A failed request answers with `{ error, message }` so the cause is actionable:

| `error` | HTTP | Meaning |
|---|---|---|
| `bad_body` | 400 | body was not valid JSON |
| `bad_url` | 400 | not an AO3 work or series link |
| `bad_status` | 400 | not one of the five reading statuses |
| `expired_session` | 401 | `AO3_SESSION` no longer works; replace it and restart |
| `restricted` | 403 | logged-in only, and no `AO3_SESSION` is set |
| `missing` | 404 | AO3 has no such work; it may have been deleted |
| `locked` | 503 | another program holds the database write lock |
| `error` / `unparseable` | 502 | AO3 unreachable, or its page could not be read |

For a fic already stored, a `restricted`, `missing` or `error` outcome is also
written to its `fetch_status` and `fetch_error`. A url that has never been
imported leaves no row behind.

Both write endpoints answer `locked` if a database browser holds the write lock.

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

- **Import** in the header opens a URL box: paste an AO3 work or series link and
  it is fetched, saved and opened. The form locks while in flight, since a cold
  fetch from AO3 takes seconds and imports run one at a time server-side.
  Failures are shown in place with the reason
- Search box (debounced 300ms), status chips, favourites toggle, sort select
- Cursor-free pagination via **Load more**; the offset tracks what actually
  rendered, so a failed or superseded page can't leave a gap
- Filters are mirrored into the query string with `replaceState`, so a filtered
  view is linkable and survives reload without eating the Back button
- Clicking a card opens a detail dialog with full tags, summary, note and a link
  to `resume_url` (*Continue Reading*) or `url`
- The dialog's **Reading status** select overrides the derived status. A failed
  save puts the control back and says so, leaving the row as it was
- The open dialog owns a history entry, so Back dismisses it; focus is trapped
  and restored, and a live region announces the result count

Both list and detail requests are sequence-numbered, so a slow response that lost
the race is discarded rather than overwriting fresher results.

## Layout

```
server/server.js   HTTP server, SQLite queries, static file serving
server/import.js   AO3 url normalisation and fetching
server/parse.js    AO3 work and series page parsing
server/store.js    writing a parsed page back to the database
server/fixtures/   captured AO3 pages used by the parser tests
server/*.test.js   node:test suites
public/            index.html, app.js, style.css
db/schema.sql      schema of record
db/migrate_001.sql upgrade path for the enrichment columns
db/migrate_002.sql upgrade path for the caught_up status
docs/decisions/    architecture decision records
docs/history.md    artefacts kept in the repository but not wired up
```
