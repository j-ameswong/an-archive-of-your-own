# History

Background on artefacts that remain in the repository but are not part of the
running system.

## The multi-site schema

`db/archive_schema.sql` and `db/archive.sqlite3` describe a fic archive spanning
more than one site. Against the current `db/schema.sql` they carry:

| Column | Purpose |
|---|---|
| `site`, `site_ref` | which site a fic came from, and its id there |
| `tier`, `tier_rank` | a ranking axis, seeded into `favourite` when that column was added |
| `fandom_bucket` | a fandom grouping |
| `last_position`, `position_unit` | reading position as a chapter number *or* a forum page |

The current schema is AO3-only: `slug` replaces `site` + `site_ref`, and
`chapter` replaces `last_position` + `position_unit`.

Nothing in `server/` reads either file. `db/archive_schema.sql` is kept in the
repository as the record of what the schema narrowed down from;
`db/archive.sqlite3` is a database and so is gitignored like the others, and
exists only where it was built.

Commits: `e45c9e2` (original schema), `717b1d9` (move to the AO3 database),
`a377bf7` (drop `fandom_bucket`). The repository does not record why the project
narrowed to AO3.
