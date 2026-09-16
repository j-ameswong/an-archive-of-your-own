# An Archive Of Your Own

A personal, offline browser for a private AO3 reading list. You can track
what you've read, abandoned, or are currently reading. A small Node HTTP
server reads a local SQLite database and serves a single-page frontend for
searching, filtering and skimming saved works and series.

## Requirements

- Node.js 24+ (uses the built-in `node:sqlite` module
- A populated `db/ao3.sqlite3`

No dependencies, no build step.

## Running

```sh
npm start              # http://localhost:4173
PORT=8080 npm start    # or pick a port
```

The database is opened **read-only** by the UI for now. Status, favourites
and notes are edited directly in the database.

## Getting a database

`db/*.sqlite3` is gitignored, so a fresh clone has no data. `db/ao3_schema.sql`
is the schema of record:

```sh
sqlite3 db/ao3.sqlite3 < db/ao3_schema.sql
```

Then load rows into `fic` and `fic_tag` yourself.

> **Pending:** import and scheduled enrichment are not built yet. Import will
> pull works and series into `fic`/`fic_tag`; enrichment will refresh the
> upstream facts (word count, chapter count, kudos, bookmarks, `updated_at`) on
> a schedule, leaving curation and reading state untouched. Until they exist,
> the database is populated by hand — including `fic_fts`, which has no sync
> triggers.

## Data model

`db/ao3_schema.sql` — two tables and a search index.

**`fic`** — one row per AO3 work or series (`kind`), keyed by `slug`.
Columns split into three groups:

- *Upstream facts* (`title`, `author`, `word_count`, `chapters_done/total`,
  `rating`, `kudos`, `bookmarks`, timestamps) — refreshed on import.
- *Curation* (`note`, `favourite`) — set by hand, never re-derived, so a
  re-import can't clobber it.
- *Reading state* (`status`, `chapter`, `resume_url`, `last_read_at`) — this
  database is the system of record. `status` is one of `read`, `unfinished`,
  `dropped`, `to_read`.

**`fic_tag`** — `(fic_id, tag_type, tag)`, where `tag_type` is one of `fandom`,
`relationship`, `character`, `freeform`, `category`, `warning`, `genre`.

**`fic_fts`** — an FTS5 index over `title`, `author`, `summary`, `tags`.
It is contentless (`content=''`) and has **no triggers**: rows must be inserted
by the importer with `rowid` set to `fic.id`, which is what the search query
joins on.

`db/schema.sql` + `db/archive.sqlite3` are the previous multi-site schema
(`site`, `tier`, `last_position`/`position_unit`), kept from before the AO3-only
migration. Nothing in `server/` reads them.

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

Both list and detail requests are sequence-numbered, so a slow response that
lost the race is discarded rather than overwriting fresher results.

## Layout

```
server/server.js   HTTP server, SQLite queries, static file serving
public/            index.html, app.js, style.css
db/ao3_schema.sql  current schema
db/schema.sql      previous multi-site schema (unused)
```
