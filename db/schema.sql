-- Personal AO3 archive

CREATE TABLE IF NOT EXISTS fic (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL,     -- work|series
    slug           TEXT NOT NULL,
    url            TEXT NOT NULL,

    -- AO3 metadata, refreshed on import
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

    -- Fetch tracking: attempt timestamp, outcome and error.
    -- NULL status = never fetched; 'fichub' is unused.
    -- See docs/decisions/0001-scrape-ao3-directly.md for its history.
    -- Keep column order compatible with db/migrate_002.sql's INSERT ... SELECT *.
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

-- The store re-indexes entries using DELETE ... WHERE rowid = ?, supported by
-- contentless_delete. Each rowid must match fic.id; no triggers maintain this index.
CREATE VIRTUAL TABLE IF NOT EXISTS fic_fts USING fts5(
    title, author, summary, tags, content='', contentless_delete=1
);

CREATE INDEX IF NOT EXISTS idx_fic_status ON fic(status);
CREATE INDEX IF NOT EXISTS idx_fic_fav    ON fic(favourite);
CREATE INDEX IF NOT EXISTS idx_fic_words  ON fic(word_count);
CREATE INDEX IF NOT EXISTS idx_tag_lookup ON fic_tag(tag_type, tag);
