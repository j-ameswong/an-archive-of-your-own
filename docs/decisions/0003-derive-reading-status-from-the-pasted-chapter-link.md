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

`caught_up` is added to the status `CHECK`. `PATCH /api/fics/:id` overrides the
derived value and sets `state_source = 'user'`, which stops a later import
re-deriving it.

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
  derived; they stay `to_read` until overridden.
