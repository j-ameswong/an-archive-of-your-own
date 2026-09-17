-- 003: give finished fics the reading position they always implied.
--
-- The card shows reading progress as chapter/chapters_done. Most of the
-- archive predates anything recording a chapter, so 484 fics marked read carry
-- no position and would render as 0 of however many -- zero progress on fics
-- that were read to the end.
--
-- A status of 'read' or 'caught_up' means the reader reached the last posted
-- chapter, so that is the position those rows already assert. This writes it
-- down. Status, state_source, last_read_at and resume_url are untouched: the
-- rows stay hand-curated, and state_source = 'user' keeps them that way.
--
-- Rows with no chapters_done -- series, and works never enriched -- have
-- nothing to copy from and keep a NULL position.
--
-- Safe to run twice; the second pass matches nothing.
--
-- Apply once:  sqlite3 db/ao3.sqlite3 < db/migrate_003.sql

BEGIN;

UPDATE fic
   SET chapter = chapters_done
 WHERE status IN ('read', 'caught_up')
   AND chapter IS NULL
   AND chapters_done IS NOT NULL;

COMMIT;
