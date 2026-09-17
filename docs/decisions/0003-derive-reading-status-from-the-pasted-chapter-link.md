# Decision: derive reading status from the pasted chapter link

## Context

`fic.status` is the system of record for whether a fic has been read. The schema
has always carried `chapter`, `resume_url` and `state_source` alongside it, and
the frontend has always rendered a *Continue Reading* link from `resume_url`,
but nothing wrote any of the three: every imported fic arrived as `to_read` and
stayed there until the database was edited by hand.

Two facts constrain any automatic derivation:

- AO3 links a chapter by a global chapter id, not by its position in the work.
  `/works/123/chapters/456` does not say which chapter of how many that is.
- The four statuses at the time — `read`, `unfinished`, `dropped`, `to_read` —
  could not express a fic whose every posted chapter has been read while the
  author is still writing.

## Decision

A pasted chapter deep link is the reader's position. `normalizeUrl` keeps its
`chapter_id` alongside the canonical slug; the chapter menu on the fetched page
(`<select id="selected_id">`) turns that id into a number by its position.

Status follows from that number:

| Chapter | Author finished | Status |
|---|---|---|
| none, or 1 | either | `to_read` |
| past the first, short of the last posted | either | `unfinished` |
| the last posted | no | `caught_up` |
| the last posted | yes | `read` |

`caught_up` is added to the status `CHECK`.

The reader may set either half of this by hand through `PATCH /api/fics/:id`,
and the two halves mean different things. A **chapter** is a position, so it
re-derives the status and leaves `state_source = 'import'`, keeping it open to a
later refresh. A **status** is a verdict, so it pins the value and sets
`state_source = 'user'`, which stops a later import re-deriving it. Editing the
chapter therefore discards an earlier hand-picked status — visibly, since both
controls sit together in the detail panel.

## Alternatives

**An explicit `chapter` field in the import body.** Rejected: it requires the
reader to know their chapter number, needs a number input in the import form,
and leaves `resume_url` empty, so *Continue Reading* would stay dead.

**Accepting both a deep link and an explicit field.** Rejected as two code paths
for one signal.

**Reading position from AO3 itself.** Not available — AO3's reading history is
per-account and not exposed per work on the pages this project fetches.

For the case where a one-chapter work is both on its first chapter and on the
last chapter of a finished work, two alternatives were considered and rejected:
treating a chapter link on a single-chapter work as `read`, and dropping the
first-chapter rule entirely so the last chapter always wins.

## Rationale

The chapter menu is already in the HTML fetched for the metadata block, above
the cut point the fixtures use, so resolving an id to a number costs no second
request and no change to the fetcher.

Chapter 1 is treated as opened rather than started because a link to chapter 1
carries no more information than a bare work link does: both are what a reader
pastes when saving something to read later. Preferring `to_read` keeps those two
pastes consistent, at the cost of never finishing a one-chapter work
automatically.

`state_source` already distinguished a derived status from a chosen one. Keeping
imports on `'import'` and confining `'user'` to the override preserves that
meaning for a later enrichment pass.

## Consequences

- A one-chapter work is never marked `read` by an import. Finishing one is
  always a hand edit.
- Adding `caught_up` required rebuilding `fic`: SQLite cannot widen a `CHECK`
  constraint in place. See `db/migrate_002.sql`.
- That migration also set `state_source = 'user'` on every row then in the
  database. Those statuses were curated by hand and most carry no chapter, so a
  pass that re-derived them would have demoted them to `to_read`.
- A re-import from a bare work link changes no reading state. Only a link naming
  a chapter records progress.
- Demoting `caught_up` to `unfinished` when an author posts a new chapter is not
  part of import. It belongs to scheduled metadata refresh, which is not built.
- Series carry no chapter counts and no chapter links, so nothing about them is
  derived; they stay `to_read` until overridden. A `chapter` is rejected on a
  series outright.
- A chapter set by hand clears `resume_url`. The link is built from AO3's
  chapter id and the interface supplies only a number, so it cannot be rebuilt;
  the alternative of persisting the id list per fic was considered and not
  taken. Importing a chapter deep link remains the only way to get a resume
  link, and hand-editing erodes the 80 rows that currently have one.
- `state_source = 'import'` now also covers a status derived from a chapter the
  reader typed. The value name is narrower than what it records; widening it
  would mean another table rebuild, so it stays.
- Reading position became the archive's primary chapter display, so the 484
  rows marked `read` that carried no position were backfilled to their last
  posted chapter — the position that status already asserts. See
  `db/migrate_003.sql`. 165 of them are works their authors have not finished,
  which now read as "all 47 posted chapters read, more coming"; they keep
  `state_source = 'user'`, so nothing will re-derive them into `caught_up`.
