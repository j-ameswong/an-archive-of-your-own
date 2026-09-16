// Writing a parsed page back to the database.
//
// Enrichment owns the upstream facts and nothing else. Curation (note,
// favourite) and reading state (status, chapter, resume_url, last_read_at) are
// the reader's, and a re-import must never overwrite them -- that separation is
// the whole point of the schema.

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
 * @param {{slug: string, url: string}} target from normalizeUrl
 * @param record from parseWork or parseSeries
 * @returns {{id: number, created: boolean}}
 */
export function upsertFic(db, target, record) {
  return transaction(db, () => {
    const existing = db.prepare('SELECT id FROM fic WHERE slug = ?').get(target.slug);
    const stamp = now();
    const values = FACTS.map((c) => record[c] ?? null);

    let id;
    if (existing) {
      write(
        db,
        `UPDATE fic SET ${FACTS.map((c) => `${c} = ?`).join(', ')},
                        enriched_at = ?, fetch_status = 'ok', fetch_error = NULL
         WHERE id = ?`
      ).run(...values, stamp, existing.id);
      id = existing.id;
    } else {
      // A newly imported fic is something to read, and the import said so --
      // state_source stays 'import' until the reader touches it.
      const result = write(
        db,
        `INSERT INTO fic (kind, slug, url, ${FACTS.join(', ')},
                          enriched_at, fetch_status, favourite,
                          status, state_source, state_changed_at)
         VALUES (?, ?, ?, ${FACTS.map(() => '?').join(', ')},
                 ?, 'ok', 0, 'to_read', 'import', ?)`
      ).run(record.kind, target.slug, target.url, ...values, stamp, stamp);
      id = Number(result.lastInsertRowid);
    }

    writeTags(db, id, record.tags ?? {});
    reindex(db, id, record);
    return { id, created: !existing };
  });
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
