// The HTTP layer: routing, request validation and the SQLite queries behind
// each endpoint. Everything here takes its database as an argument, so the
// tests can hand it an in-memory one and server.js can hand it the real file.

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUrl, fetchAo3 } from './import.js';
import { parseWork, parseSeries } from './parse.js';
import { upsertFic, recordFetchFailure, applyReadingState, setCuration } from './store.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const SORT_COLUMNS = {
  updated_at: 'updated_at',
  published_at: 'published_at',
  word_count: 'word_count',
  kudos: 'kudos',
  title: 'title',
};

// User input is never a valid FTS5 expression on its own: bare -, *, ", :, (
// and the AND/OR/NOT keywords are all operators and raise a syntax error.
// Keep only letter/digit runs and quote each one, so every term is a literal.
// Trailing * keeps prefix matching, which LIKE '%q%' used to give for free.
function ftsQuery(q) {
  const terms = q.match(/[\p{L}\p{N}]+/gu);
  if (!terms) return null;
  return terms.map((t) => `"${t}"*`).join(' AND ');
}

function listFics(db, params) {
  const where = [];
  const args = [];

  const status = (params.get('status') || '').split(',').filter(Boolean);
  if (status.length) {
    where.push(`status IN (${status.map(() => '?').join(',')})`);
    args.push(...status);
  }

  if (params.get('favourite') === '1') {
    where.push('favourite = 1');
  }

  const q = (params.get('q') || '').trim();
  if (q) {
    const match = ftsQuery(q);
    if (match) {
      where.push('id IN (SELECT rowid FROM fic_fts WHERE fic_fts MATCH ?)');
      args.push(match);
    } else {
      // q was punctuation only: no searchable term, so match nothing,
      // as the old LIKE '%q%' did rather than returning everything.
      where.push('0');
    }
  }

  const sortCol = SORT_COLUMNS[params.get('sort')] || 'updated_at';
  const dir = params.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(params.get('limit'), 10) || 30, 1), 100);
  const offset = Math.max(parseInt(params.get('offset'), 10) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM fic ${whereSql}`)
    .get(...args).c;

  const rows = db
    .prepare(
      `SELECT id, kind, title, author, word_count, chapters_done, chapters_total,
              is_complete, rating, updated_at, published_at, kudos, bookmarks,
              favourite, status, chapter, url
       FROM fic
       ${whereSql}
       ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, id ${dir}
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);

  const ids = rows.map((r) => r.id);
  const fandomsById = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT fic_id, tag FROM fic_tag WHERE tag_type = 'fandom' AND fic_id IN (${placeholders})`
      )
      .all(...ids);
    for (const t of tagRows) fandomsById.get(t.fic_id).push(t.tag);
  }

  const items = rows.map((r) => ({ ...r, fandoms: fandomsById.get(r.id) }));

  return { items, total, limit, offset };
}

const TAG_TYPES = ['fandom', 'relationship', 'character', 'freeform', 'category', 'warning', 'genre'];

function getFic(db, id) {
  const fic = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  if (!fic) return null;

  const tagRows = db
    .prepare('SELECT tag_type, tag FROM fic_tag WHERE fic_id = ?')
    .all(id);

  const tags = Object.fromEntries(TAG_TYPES.map((t) => [t, []]));
  for (const row of tagRows) {
    if (!tags[row.tag_type]) tags[row.tag_type] = [];
    tags[row.tag_type].push(row.tag);
  }

  return { ...fic, tags };
}

// The five values db/schema.sql allows. Reading state and curation are the
// reader's own, and are the only parts of a row they may set directly; the
// upstream facts belong to the import path.
const STATUSES = new Set(['to_read', 'unfinished', 'caught_up', 'read', 'dropped']);

// A chapter is a whole number of chapters into the work, or null for "nowhere".
// An out-of-range value is a typo; clamping one would record a reading position
// the reader never gave.
function validChapter(value, row) {
  // A series has no chapters of its own, however far into it the reader is.
  if (row.kind === 'series') return false;
  if (value === null) return true;
  if (!Number.isInteger(value) || value < 1) return false;
  // A work that has never been enriched has no count to check against.
  return row.chapters_done == null || value <= row.chapters_done;
}

function getMeta(db) {
  const statusCounts = db
    .prepare('SELECT status, COUNT(*) AS c FROM fic GROUP BY status')
    .all();

  return { status_counts: statusCounts };
}

// A request failure the caller can act on, rather than a 500.
const IMPORT_ERRORS = {
  bad_body: [400, 'That request body was not valid JSON.'],
  bad_url: [400, 'Not an AO3 work or series link.'],
  bad_status: [400, 'Not a reading status.'],
  bad_chapter: [400, 'Not a chapter number for this fic.'],
  bad_favourite: [400, 'Favourite is true or false.'],
  bad_note: [400, 'A note is text, or null to clear it.'],
  empty_patch: [400, 'Send a status, a chapter, a favourite or a note.'],
  restricted: [403, 'This work is restricted to logged-in AO3 users. Set AO3_SESSION in .env.'],
  expired_session: [401, 'The AO3 session in .env has expired. Replace AO3_SESSION and restart.'],
  missing: [404, 'AO3 has no such work or series. It may have been deleted.'],
  error: [502, 'AO3 could not be reached.'],
  locked: [503, 'The database is open in another program. Close it and try again.'],
  unparseable: [502, 'That page could not be read. AO3 may have changed its markup.'],
};

// Bodies here are a url or a reader's note; anything larger is not a request
// we serve, and the cap is what keeps a note from being unbounded.
const MAX_BODY_BYTES = 4096;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function importFic(db, body) {
  const target = normalizeUrl(body?.url);
  if (!target) return { error: 'bad_url' };

  const res = await fetchAo3(target.url);
  if (res.status !== 'ok') {
    // Only fics already stored get a failure recorded; a url that has never
    // been imported must not leave an empty row behind.
    recordFetchFailure(db, target.slug, res.status === 'expired_session' ? 'error' : res.status,
      res.error ?? null);
    return { error: res.status };
  }

  let record;
  try {
    record = target.kind === 'series' ? parseSeries(res.html) : parseWork(res.html);
  } catch (err) {
    recordFetchFailure(db, target.slug, 'error', err.message);
    return { error: 'unparseable' };
  }

  try {
    const { id, created } = upsertFic(db, target, record);
    return { fic: getFic(db, id), created };
  } catch (err) {
    // SQLITE_BUSY: something else holds the write lock for longer than we wait.
    if (err?.errcode === 5) return { error: 'locked' };
    throw err;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

/**
 * Build the request handler for one database.
 *
 * @param db an open read-write DatabaseSync
 * @returns {(req, res) => Promise<void>}
 */
export function createApp(db) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      if (url.pathname === '/api/fics') {
        return sendJson(res, 200, listFics(db, url.searchParams));
      }

      if (url.pathname === '/api/meta') {
        return sendJson(res, 200, getMeta(db));
      }

      if (url.pathname === '/api/import') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          const [status, message] = IMPORT_ERRORS.bad_body;
          return sendJson(res, status, { error: 'bad_body', message });
        }
        const result = await importFic(db, body);
        if (result.error) {
          const [status, message] = IMPORT_ERRORS[result.error];
          return sendJson(res, status, { error: result.error, message });
        }
        return sendJson(res, result.created ? 201 : 200, result);
      }

      const detailMatch = url.pathname.match(/^\/api\/fics\/(\d+)$/);
      if (detailMatch) {
        const id = Number(detailMatch[1]);

        if (req.method === 'PATCH') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            const [status, message] = IMPORT_ERRORS.bad_body;
            return sendJson(res, status, { error: 'bad_body', message });
          }
          // A JSON body may be any value; only an object can carry these keys.
          const patch = body && typeof body === 'object' ? body : {};
          const fail = (error) => {
            const [status, message] = IMPORT_ERRORS[error];
            return sendJson(res, status, { error, message });
          };

          const setsStatus = 'status' in patch;
          const setsChapter = 'chapter' in patch;
          const setsFavourite = 'favourite' in patch;
          const setsNote = 'note' in patch;
          if (!setsStatus && !setsChapter && !setsFavourite && !setsNote) {
            return fail('empty_patch');
          }
          if (setsStatus && !STATUSES.has(patch.status)) return fail('bad_status');
          // Curation has no upstream rule to check against: a flag is a flag, and
          // a note is whatever the reader typed. Only the types are ours to hold.
          if (setsFavourite && typeof patch.favourite !== 'boolean') return fail('bad_favourite');
          if (setsNote && patch.note !== null && typeof patch.note !== 'string') {
            return fail('bad_note');
          }

          // The chapter is checked against this fic, so the row is needed first.
          const row = db.prepare('SELECT kind, chapters_done FROM fic WHERE id = ?').get(id);
          if (!row) return sendJson(res, 404, { error: 'not found' });
          if (setsChapter && !validChapter(patch.chapter, row)) return fail('bad_chapter');

          try {
            // Two writes, because reading state and curation are separate
            // concerns; each ignores the other's keys.
            if (setsStatus || setsChapter) applyReadingState(db, id, patch);
            if (setsFavourite || setsNote) setCuration(db, id, patch);
          } catch (err) {
            // SQLITE_BUSY, as on import: the database is open elsewhere.
            if (err?.errcode !== 5) throw err;
            return fail('locked');
          }
          return sendJson(res, 200, getFic(db, id));
        }

        const fic = getFic(db, id);
        if (!fic) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, fic);
      }

      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }

      return serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'internal error' });
    }
  };
}
