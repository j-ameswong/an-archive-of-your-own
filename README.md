# An Archive Of Your Own

A personal, offline browser for a private AO3 reading list. You can track what
you've read, abandoned, or are currently reading. A small Node HTTP server reads
a local SQLite database and serves a single-page frontend for searching,
filtering and skimming saved works and series.

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

The server opens the database read-only. Status, favourites and notes are edited
directly in the database.

## Configuration

`npm start` loads a root `.env` if one is present. It is gitignored.

| Variable | Purpose |
|---|---|
| `AO3_SESSION` | `_otwarchive_session` cookie from a logged-in AO3 session. Without it, works their authors restricted to logged-in users cannot be fetched. See [ADR-0002](docs/decisions/0002-authenticate-with-an-ao3-session-cookie.md). |
| `ARCHIVE_CONTACT` | Contact address, sent in the `User-Agent`. AO3 asks automated clients to be contactable. |
| `PORT` | HTTP port, default 4173. |
| `AO3_MIN_INTERVAL_MS` | Milliseconds between AO3 requests, default 5000. `npm test` sets it to 0. |

`.env` is read at process start, so replacing an expired `AO3_SESSION` needs a
restart. A login redirect while a cookie is set is reported as
`expired_session`, distinguishing a dead cookie from a genuinely restricted
work.

## Getting a database

`db/*.sqlite3` is gitignored, so a fresh clone has no data. `db/ao3_schema.sql`
is the schema of record:

```sh
sqlite3 db/ao3.sqlite3 < db/ao3_schema.sql
```

To bring a database created before the enrichment columns up to date:

```sh
sqlite3 db/ao3.sqlite3 < db/migrate_001.sql
```

Rows are loaded into `fic`, `fic_tag` and `fic_fts` by hand; `fic_fts` has no
sync triggers.

## Data model

`db/ao3_schema.sql` — two tables and a search index.

**`fic`** — one row per AO3 work or series (`kind`), keyed by `slug`. Columns
fall into four groups:

- *Upstream facts* (`title`, `author`, `word_count`, `chapters_done/total`,
  `rating`, `kudos`, `bookmarks`, timestamps) — refreshed on import.
- *Curation* (`note`, `favourite`) — set by hand, never re-derived, so a
  re-import can't clobber it.
- *Reading state* (`status`, `chapter`, `resume_url`, `last_read_at`) — this
  database is the system of record. `status` is one of `read`, `unfinished`,
  `dropped`, `to_read`.
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

`db/schema.sql` and `db/archive.sqlite3` are unused; nothing in `server/` reads
them. See [docs/history.md](docs/history.md).

## Import

Metadata comes from AO3 work and series pages, fetched and parsed directly
rather than through a third-party API — see
[ADR-0001](docs/decisions/0001-scrape-ao3-directly.md).

`server/import.js` provides:

- `normalizeUrl(input)` → `{ kind, slug, url }`, or `null` for anything that is
  not an AO3 work or series link. Chapter deep links, `?view_adult=true`,
  fragments, collection-scoped paths and bare hostnames all collapse onto one
  `slug`.
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
- Series pages state no rating, kudos, chapter counts or full tag lists; those
  come back `null` or empty.

Database writes and the frontend entry point are not built yet. Scheduled
enrichment will reuse the same fetch and parse path, selecting rows by
`enriched_at` instead of a pasted URL, and will leave curation and reading state
untouched.

AO3 renders timestamps in the logged-in account's timezone, so a page fetched
with `AO3_SESSION` set can report `published_at` and `updated_at` a day apart
from the same page fetched anonymously.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/fics` | `{ items, total, limit, offset }` — each item carries its `fandoms` array |
| `GET /api/fics/:id` | one fic with `tags` grouped by type |
| `GET /api/meta` | per-`status` counts |

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

- Search box (debounced 300ms), status chips, favourites toggle, sort select
- Cursor-free pagination via **Load more**; the offset tracks what actually
  rendered, so a failed or superseded page can't leave a gap
- Filters are mirrored into the query string with `replaceState`, so a filtered
  view is linkable and survives reload without eating the Back button
- Clicking a card opens a detail dialog with full tags, summary, note and a link
  to `resume_url` (*Continue Reading*) or `url`
- The open dialog owns a history entry, so Back dismisses it; focus is trapped
  and restored, and a live region announces the result count

Both list and detail requests are sequence-numbered, so a slow response that lost
the race is discarded rather than overwriting fresher results.

## Layout

```
server/server.js   HTTP server, SQLite queries, static file serving
server/import.js   AO3 url normalisation and fetching
server/parse.js    AO3 work and series page parsing
server/fixtures/   captured AO3 pages used by the parser tests
server/*.test.js   node:test suites
public/            index.html, app.js, style.css
db/ao3_schema.sql  schema of record
db/migrate_001.sql upgrade path for the enrichment columns
docs/decisions/    architecture decision records
```
