-- Personal fic archive

CREATE TABLE IF NOT EXISTS fic (
    id             INTEGER PRIMARY KEY,
    site           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    site_ref       TEXT NOT NULL,
    url            TEXT NOT NULL,

    -- facts about the fic, refreshed from the extraction DB on every build
    title          TEXT,
    author         TEXT,
    author_url     TEXT,
    summary        TEXT,
    word_count     INTEGER,
    chapters_done  INTEGER,
    chapters_total INTEGER,          -- NULL = author has not declared a total
    is_complete    INTEGER,          -- the *author* finished it; says nothing about the reader
    rating         TEXT,
    published_at   TEXT,
    updated_at     TEXT,
    kudos          INTEGER,          -- AO3 kudos ≍ FFN favs
    bookmarks      INTEGER,          -- AO3 bookmarks ≍ FFN reviews

    -- curation: the reader's own judgement, irreplaceable, never re-derivable
    tier           TEXT,             -- retained as history; no longer a browsing axis
    tier_rank      INTEGER,
    fandom_bucket  TEXT,
    note           TEXT,

    -- favourite is the reader's own flag and is never re-derived. It is seeded
    -- once -- from the Platinum tier, when the column is first created -- and
    -- from then on only a hand edit changes it, so a rebuild can neither
    -- un-favourite nor re-favourite anything.
    favourite      INTEGER NOT NULL DEFAULT 0,

    -- reading state: the system of record lives here, not upstream
    status         TEXT NOT NULL CHECK (status IN ('read','unfinished','dropped','to_read')),
    last_position  INTEGER,          -- chapter number, or forum page
    position_unit  TEXT CHECK (position_unit IN ('chapter','page')),
    resume_url     TEXT,             -- deep link to exactly where reading stopped
    last_read_at   TEXT,
    state_source   TEXT NOT NULL DEFAULT 'import'
                        CHECK (state_source IN ('import','user')),
    state_changed_at TEXT,

    UNIQUE (site, site_ref)
);

CREATE TABLE IF NOT EXISTS fic_tag (
    fic_id   INTEGER NOT NULL REFERENCES fic(id) ON DELETE CASCADE,
    tag_type TEXT NOT NULL,          -- fandom|relationship|character|freeform|category|warning|genre
    tag      TEXT NOT NULL,
    PRIMARY KEY (fic_id, tag_type, tag)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS fic_fts USING fts5(
    title, author, summary, tags, content=''
);

CREATE INDEX IF NOT EXISTS idx_fic_status ON fic(status);
CREATE INDEX IF NOT EXISTS idx_fic_site   ON fic(site);
CREATE INDEX IF NOT EXISTS idx_fic_tier   ON fic(tier_rank);
CREATE INDEX IF NOT EXISTS idx_fic_fav    ON fic(favourite);
CREATE INDEX IF NOT EXISTS idx_fic_words  ON fic(word_count);
CREATE INDEX IF NOT EXISTS idx_tag_lookup ON fic_tag(tag_type, tag);

