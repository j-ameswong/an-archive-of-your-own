-- 002: add the 'caught_up' reading status.
--
-- A fic whose every posted chapter has been read, but whose author has not
-- declared it finished. Distinct from 'read' -- there is more coming -- and
-- from 'unfinished', which means the reader stopped partway.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt. Column order
-- below is the order db/schema.sql declares and the live database already has,
-- which is what lets INSERT ... SELECT * carry the rows across.
--
-- Apply once:  sqlite3 db/ao3.sqlite3 < db/migrate_002.sql

PRAGMA foreign_keys = off;

BEGIN;

CREATE TABLE fic_new (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL,     -- work|series
    slug           TEXT NOT NULL,
    url            TEXT NOT NULL,

    -- fic metadata, refreshed during scheduled enrich/import
    title          TEXT,
    author         TEXT,
    author_url     TEXT,
    summary        TEXT,
    word_count     INTEGER,
    chapters_done  INTEGER,
    chapters_total INTEGER,          -- NULL = author has not declared a total
    is_complete    INTEGER,          -- the author marked it as finished
    rating         TEXT,
    published_at   TEXT,
    updated_at     TEXT,
    kudos          INTEGER,
    bookmarks      INTEGER,

    -- set manually
    note           TEXT,

    favourite      INTEGER NOT NULL DEFAULT 0,

    -- reading state: the system of record lives here, not upstream
    status         TEXT NOT NULL
                        CHECK (status IN ('read','caught_up','unfinished','dropped','to_read')),
    chapter        INTEGER,          -- last chapter number reached
    resume_url     TEXT,             -- deep link to exactly where reading stopped
    last_read_at   TEXT,
    state_source   TEXT NOT NULL DEFAULT 'import'
                        CHECK (state_source IN ('import','user')),
    state_changed_at TEXT,

    enriched_at    TEXT,
    fetch_status   TEXT CHECK (fetch_status IN ('ok','restricted','missing','error','fichub')),
    fetch_error    TEXT,

    UNIQUE (slug)
);

INSERT INTO fic_new SELECT * FROM fic;

DROP TABLE fic;
ALTER TABLE fic_new RENAME TO fic;

CREATE INDEX IF NOT EXISTS idx_fic_status ON fic(status);
CREATE INDEX IF NOT EXISTS idx_fic_fav    ON fic(favourite);
CREATE INDEX IF NOT EXISTS idx_fic_words  ON fic(word_count);

-- Every row in the database at this point was curated by hand, long before
-- anything derived a status from a chapter number. Marking them 'user' stops a
-- later enrichment pass from re-deriving them: 544 of the 550 'read' rows carry
-- no chapter, so a re-derivation would demote them all to 'to_read'.
UPDATE fic SET state_source = 'user';

COMMIT;

PRAGMA foreign_keys = on;
