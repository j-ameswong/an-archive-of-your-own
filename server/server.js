import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PATH = join(ROOT, 'db', 'ao3.sqlite3');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = process.env.PORT || 4173;

const db = new DatabaseSync(DB_PATH, { readOnly: true });

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

function listFics(params) {
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
              favourite, status, url
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

function getFic(id) {
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

function getMeta() {
  const statusCounts = db
    .prepare('SELECT status, COUNT(*) AS c FROM fic GROUP BY status')
    .all();

  return { status_counts: statusCounts };
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/fics') {
      return sendJson(res, 200, listFics(url.searchParams));
    }

    if (url.pathname === '/api/meta') {
      return sendJson(res, 200, getMeta());
    }

    const detailMatch = url.pathname.match(/^\/api\/fics\/(\d+)$/);
    if (detailMatch) {
      const fic = getFic(Number(detailMatch[1]));
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
});

server.listen(PORT, () => {
  console.log(`AO3 archive browser running at http://localhost:${PORT}`);
});
