# Prototype retrospective

Notes from the completed prototype. For setup and current behaviour, see the
[README](../README.md); for the earlier schema, see the [project history](history.md).

## Purpose and findings

**Complete and retired.** This prototype helped work through a few design
questions before planning a larger project with support for more sites. It
works and has a test suite, but is no longer being developed.

The main lessons were:

- **A chapter link can tell us the reading status.** The chapter you paste is
  usually enough to work out whether you've started, caught up or finished.
  You can still set a status yourself. See [ADR-0003](decisions/0003-derive-reading-status-from-the-pasted-chapter-link.md).
- **Fetching directly from AO3 is practical, but needs care.** Requests run one
  at a time, and the parser reports an error if expected metadata is missing.
  See [ADR-0001](decisions/0001-scrape-ao3-directly.md).
- **Refreshing a fic must preserve the reader's choices.** Imports update AO3
  metadata without changing your notes, favourites or manually chosen status.

The prototype was developed on Node.js 26.

## What I would do differently

A few things I'd change if I were building this again:

- **Keep the search index in sync automatically.** `store.js` re-indexes each
  fic on import, but nothing in the database enforces that. SQLite triggers
  would make it harder to forget an index update.
- **Refresh stale entries.** New chapters appear only after you re-import a
  fic. `enriched_at` records fetch attempts but is never used to schedule
  updates. That's manageable for a personal list, but less useful as it grows.
- **Make each edit a single transaction.** `PATCH` validates everything first,
  then writes reading state and notes/favourites separately. A crash between
  those writes could leave an edit partly saved.
- **Remove the unused `fichub` fetch status.** It remains in the schema because
  removing it would require rebuilding the table, and didn't justify another
  migration for this prototype.
- **Clarify the static-file safety checks.** The path-traversal check in
  `serveStatic` is unreachable because the URL parser resolves dot segments
  first, including `%2e%2e`. Leaving it there makes its role misleading.
- **Plan for AO3 markup changes.** The parser reports missing metadata instead
  of saving blanks, but imports can still break without warning. Captured
  fixtures test known pages; they can't tell us when the live site changes.

## Search implementation notes

Earlier comments in `server/app.js` described a search using `LIKE '%q%'`.
The FTS5 implementation splits input into literal terms and supports prefix
matching. A comment in `server/app.test.js` also recorded that punctuation and
FTS5 operators previously caused HTTP 500 responses. Those comments did not
record the reason for moving from `LIKE` to FTS5.
