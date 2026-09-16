-- Personal AO3 archive

CREATE TABLE IF NOT EXISTS fic (
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
    status         TEXT NOT NULL CHECK (status IN ('read','unfinished','dropped','to_read')),
    chapter        INTEGER,          -- last chapter number reached
    resume_url     TEXT,             -- deep link to exactly where reading stopped
    last_read_at   TEXT,
    state_source   TEXT NOT NULL DEFAULT 'import'
                        CHECK (state_source IN ('import','user')),
    state_changed_at TEXT,

    -- Enrichment bookkeeping: when the upstream facts above were last
    -- refreshed, and why the last attempt failed. NULL status = never fetched;
    -- 'fichub' marks a row filled from the fallback, whose numbers can lag AO3
    -- by years. Last in the table because ALTER TABLE ADD COLUMN appends, and
    -- an existing database must end up with the column order this file
    -- declares.
    enriched_at    TEXT,
    fetch_status   TEXT CHECK (fetch_status IN ('ok','restricted','missing','error','fichub')),
    fetch_error    TEXT,

    UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS fic_tag (
    fic_id   INTEGER NOT NULL REFERENCES fic(id) ON DELETE CASCADE,
    tag_type TEXT NOT NULL,          -- fandom|relationship|character|freeform|category|warning|genre
    tag      TEXT NOT NULL,
    PRIMARY KEY (fic_id, tag_type, tag)
) WITHOUT ROWID;

-- contentless_delete lets enrichment re-index a row with
-- DELETE ... WHERE rowid = ?; without it a delete must supply the exact old
-- column values, which a contentless table cannot give back.
CREATE VIRTUAL TABLE IF NOT EXISTS fic_fts USING fts5(
    title, author, summary, tags, content='', contentless_delete=1
);

CREATE INDEX IF NOT EXISTS idx_fic_status ON fic(status);
CREATE INDEX IF NOT EXISTS idx_fic_fav    ON fic(favourite);
CREATE INDEX IF NOT EXISTS idx_fic_words  ON fic(word_count);
CREATE INDEX IF NOT EXISTS idx_tag_lookup ON fic_tag(tag_type, tag);
