// Writing a parsed page back to the database.
//
// Enrichment owns the upstream facts and nothing else. Curation (note,
// favourite) is the reader's and is never written here -- that separation is
// the whole point of the schema.
//
// Reading state is the one thing in between. A pasted chapter link is the
// reader telling us where they stopped, so an import may set chapter,
// resume_url and a status derived from them. What it may never do is overwrite
// a status the reader set by hand: state_source says which is which.

import { TAG_TYPES } from './parse.js';

// Upstream facts, and only those. Every column here is safe to overwrite.
const FACTS = [
  'title',
  'author',
  'author_url',
  'summary',
  'word_count',
  'chapters_done',
  'chapters_total',
  'is_complete',
  'rating',
  'published_at',
  'updated_at',
  'kudos',
  'bookmarks',
];

const now = () => new Date().toISOString();

/**
 * Where an import leaves a fic, given how far into it the reader got.
 *
 * Chapter 1 is "opened", not "started": a bare link carries no chapter at all,
 * and a link to chapter 1 says no more than a bare one does. A oneshot is
 * therefore never finished automatically -- that takes a hand edit.
 *
 * @param {{chapter: number|null, chapters_done: number|null,
 *   is_complete: number|null}} state
 * @returns {'to_read'|'unfinished'|'caught_up'|'read'}
 */
export function deriveStatus({ chapter, chapters_done, is_complete }) {
  if (chapter == null || chapter <= 1) return 'to_read';
  // A series carries no chapter count of its own to be caught up with.
  if (chapters_done == null) return 'unfinished';
  if (chapter < chapters_done) return 'unfinished';
  // Every posted chapter read: finished if the author is, still running if not.
  return is_complete ? 'read' : 'caught_up';
}

// AO3 numbers chapters by a global id, so position in the page's chapter menu
// is what turns one into a chapter number. A single-chapter work has no menu,
// and its only chapter is the first. An id the work no longer lists -- a
// deleted chapter, a mangled paste -- says nothing about position at all.
function chapterNumber(record, chapterId) {
  if (!chapterId) return null;
  const at = (record.chapter_ids ?? []).indexOf(chapterId);
  if (at !== -1) return at + 1;
  return record.chapters_done === 1 ? 1 : null;
}

// Every run() reports last_insert_rowid(), and FTS5's shadow tables use rowids
// far beyond Number.MAX_SAFE_INTEGER -- reading one as a JS number throws. Ask
// for BigInt instead; the only rowid this module actually uses is fic.id, which
// it converts back.
function write(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

// Ordered exactly as db/migrate_001.sql orders it -- by tag type, then tag --
// so re-indexing a row here produces the same content the migration would.
function tagBlob(tags) {
  const all = TAG_TYPES.flatMap((type) => [...(tags[type] ?? [])].map((tag) => [type, tag]));
  // Plain comparison, not localeCompare: SQLite orders with BINARY collation.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  all.sort(([aType, aTag], [bType, bTag]) =>
    aType === bType ? cmp(aTag, bTag) : cmp(aType, bType));
  return all.map(([, tag]) => tag).join(' ') || null;
}

function reindex(db, id, record) {
  write(db, 'DELETE FROM fic_fts WHERE rowid = ?').run(id);
  write(
    db,
    'INSERT INTO fic_fts (rowid, title, author, summary, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(id, record.title, record.author, record.summary, tagBlob(record.tags));
}

function writeTags(db, id, tags) {
  write(db, 'DELETE FROM fic_tag WHERE fic_id = ?').run(id);
  const insert = write(db, 'INSERT INTO fic_tag (fic_id, tag_type, tag) VALUES (?, ?, ?)');
  for (const type of TAG_TYPES) {
    // A fic can carry the same tag under one type only; the primary key says so.
    for (const tag of new Set(tags[type] ?? [])) insert.run(id, type, tag);
  }
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Insert or refresh one fic, its tags and its search index entry.
 *
 * @param db an open read-write DatabaseSync
 * @param {{slug: string, url: string, chapter_id?: string|null}} target
 *   from normalizeUrl
 * @param record from parseWork or parseSeries
 * @returns {{id: number, created: boolean}}
 */
export function upsertFic(db, target, record) {
  return transaction(db, () => {
    const existing = db.prepare('SELECT id FROM fic WHERE slug = ?').get(target.slug);
    const stamp = now();
    const values = FACTS.map((c) => record[c] ?? null);

    const chapter = chapterNumber(record, target.chapter_id);
    // Only a chapter we could place is worth a resume link.
    const resumeUrl = chapter == null ? null : `${target.url}/chapters/${target.chapter_id}`;
    const status = deriveStatus({
      chapter,
      chapters_done: record.chapters_done ?? null,
      is_complete: record.is_complete ?? null,
    });

    let id;
    if (existing) {
      write(
        db,
        `UPDATE fic SET ${FACTS.map((c) => `${c} = ?`).join(', ')},
                        enriched_at = ?, fetch_status = 'ok', fetch_error = NULL
         WHERE id = ?`
      ).run(...values, stamp, existing.id);
      id = existing.id;

      // A re-import with no chapter link says nothing about reading state, so
      // it leaves every bit of it alone. One with a chapter link is the reader
      // recording progress -- but the status is only re-derived for a row they
      // have not taken over, which is what the CASE guards.
      if (chapter != null) {
        write(
          db,
          `UPDATE fic
              SET chapter = ?, resume_url = ?, state_changed_at = ?,
                  status = CASE WHEN state_source = 'import' THEN ? ELSE status END
            WHERE id = ?`
        ).run(chapter, resumeUrl, stamp, status, id);
      }
    } else {
      // state_source stays 'import' until the reader overrides the status: it
      // is what marks a row as still safe to re-derive.
      const result = write(
        db,
        `INSERT INTO fic (kind, slug, url, ${FACTS.join(', ')},
                          enriched_at, fetch_status, favourite,
                          status, chapter, resume_url, state_source, state_changed_at)
         VALUES (?, ?, ?, ${FACTS.map(() => '?').join(', ')},
                 ?, 'ok', 0, ?, ?, ?, 'import', ?)`
      ).run(record.kind, target.slug, target.url, ...values, stamp,
            status, chapter, resumeUrl, stamp);
      id = Number(result.lastInsertRowid);
    }

    writeTags(db, id, record.tags ?? {});
    reindex(db, id, record);
    return { id, created: !existing };
  });
}

/**
 * Set reading state by hand, from the reader rather than from a page.
 *
 * A chapter is a position, not a verdict: giving one re-derives the status and
 * hands it back to the import path, so a later refresh may move it again.
 * Giving a status pins it. Giving both writes the chapter and pins the status.
 *
 * `resume_url` is a deep link built from AO3's chapter id, and a chapter
 * number cannot rebuild one, so a hand-set chapter clears it. Pasting a chapter
 * link on import remains the way to get one.
 *
 * @param {{status?: string, chapter?: number|null}} patch validated by the
 *   caller; an absent key means "leave this alone".
 * @returns {boolean} whether a row was updated
 */
export function applyReadingState(db, id, patch) {
  const row = db
    .prepare('SELECT chapter, chapters_done, is_complete FROM fic WHERE id = ?')
    .get(id);
  if (!row) return false;

  const setsChapter = patch.chapter !== undefined;
  const chapter = setsChapter ? patch.chapter : row.chapter;
  const status = patch.status
    ?? deriveStatus({
      chapter,
      chapters_done: row.chapters_done ?? null,
      is_complete: row.is_complete ?? null,
    });

  const stamp = now();
  const columns = ['status = ?', 'state_source = ?', 'state_changed_at = ?'];
  const values = [status, patch.status ? 'user' : 'import', stamp];

  if (setsChapter) {
    columns.push('chapter = ?', 'resume_url = NULL');
    values.push(chapter);
    // Clearing a position is not a reading event.
    if (chapter !== null) {
      columns.push('last_read_at = ?');
      values.push(stamp);
    }
  }

  const result = write(db, `UPDATE fic SET ${columns.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return Number(result.changes) > 0;
}

/**
 * Record that a fetch failed, without disturbing the facts already stored.
 * Only touches a fic already in the database: a pasted url that cannot be
 * fetched is reported to the caller rather than left as an empty row.
 *
 * @param {'restricted'|'missing'|'error'} status
 * @returns {boolean} whether a row was updated
 */
export function recordFetchFailure(db, slug, status, error = null) {
  const result = write(
    db,
    `UPDATE fic SET enriched_at = ?, fetch_status = ?, fetch_error = ?
     WHERE slug = ?`
  ).run(now(), status, error, slug);
  return result.changes > 0n;
}
