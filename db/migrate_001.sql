-- 001: make the database writable by import/enrichment.
--
-- Adds the bookkeeping a scheduled enricher needs (when a row was last
-- refreshed, and why a refresh failed), and rebuilds fic_fts so a row can be
-- re-indexed in place.
--
-- Apply once:  sqlite3 db/ao3.sqlite3 < db/migrate_001.sql

BEGIN;

-- Upstream facts only. Curation and reading state are untouched by enrichment,
-- so they keep their own timestamp in state_changed_at.
ALTER TABLE fic ADD COLUMN enriched_at TEXT;

-- NULL = never fetched. 'fichub' marks a row filled from the fallback, whose
-- numbers can lag AO3 by years.
ALTER TABLE fic ADD COLUMN fetch_status TEXT
    CHECK (fetch_status IN ('ok','restricted','missing','error','fichub'));

ALTER TABLE fic ADD COLUMN fetch_error TEXT;

-- Everything already in the database was scraped from AO3 by hand and matches
-- it, so backfill rather than making the first enrich pass re-fetch all 671.
UPDATE fic SET fetch_status = 'ok' WHERE title IS NOT NULL;

-- fic_fts was contentless without contentless_delete, so a row could only be
-- deleted by supplying its exact old column values. Enrichment rewrites rows,
-- so the index has to support DELETE ... WHERE rowid = ?.
DROP TABLE fic_fts;

CREATE VIRTUAL TABLE fic_fts USING fts5(
    title, author, summary, tags, content='', contentless_delete=1
);

INSERT INTO fic_fts (rowid, title, author, summary, tags)
SELECT f.id, f.title, f.author, f.summary,
       (SELECT group_concat(t.tag, ' ' ORDER BY t.tag_type, t.tag)
          FROM fic_tag t WHERE t.fic_id = f.id)
  FROM fic f;

COMMIT;
