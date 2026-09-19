// The HTTP layer, driven over a real socket against an in-memory database.
// Nothing here reaches AO3: the import cases are the ones that fail before a
// fetch is attempted, and the fetching itself is covered in fetch.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createApp } from './app.js';
import { upsertFic, setCuration, applyReadingState } from './store.js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

let db;
let server;
let origin;

const work = (over = {}) => ({
  kind: 'work',
  title: 'A Work',
  author: 'Someone',
  summary: 'A summary.',
  word_count: 1000,
  chapters_done: 4,
  chapters_total: 4,
  is_complete: 1,
  rating: 'General Audiences',
  published_at: '2020-01-01',
  updated_at: '2020-02-01',
  kudos: 10,
  bookmarks: 3,
  chapter_ids: ['11', '12', '13', '14'],
  tags: { fandom: ['Fandom A'], character: ['Char A'], freeform: ['Slow Burn'] },
  ...over,
});

// One fixed corpus for the read tests, distinct enough that each filter and
// each sort has exactly one right answer.
function seed() {
  const add = (n, over) => upsertFic(
    db,
    { slug: `works/${n}`, url: `https://archiveofourown.org/works/${n}` },
    work(over),
  ).id;

  return {
    alpha: add(1, { title: 'Alpha', author: 'Ada', word_count: 5000, kudos: 100,
      updated_at: '2021-01-01', published_at: '2019-01-01',
      tags: { fandom: ['Wodehouse'], freeform: ['Epistolary'] } }),
    beta: add(2, { title: 'Beta', author: 'Bo', word_count: 200, kudos: 7,
      updated_at: '2022-01-01', published_at: '2018-01-01',
      tags: { fandom: ['Discworld'], freeform: ['Hurt/Comfort'] } }),
    gamma: add(3, { title: 'Gamma', author: 'Cy', word_count: 90000, kudos: 3,
      updated_at: null, published_at: '2020-06-01',
      tags: { fandom: ['Wodehouse'], freeform: ['Time Travel'] } }),
  };
}

before(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

// Each test starts from an empty table, so seeding is per-test and order-free.
function reset() {
  db.exec('DELETE FROM fic; DELETE FROM fic_tag; DELETE FROM fic_fts;');
  return seed();
}

async function api(path, init) {
  const res = await fetch(`${origin}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

const patch = (id, body) => api(`/api/fics/${id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const titles = (body) => body.items.map((i) => i.title);

// A request line written by hand, so a path that a URL parser would tidy up
// arrives at the server exactly as typed.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

test('GET /api/fics returns a page with its total', async () => {
  reset();
  const { status, body } = await api('/api/fics');

  assert.equal(status, 200);
  assert.equal(body.total, 3);
  assert.equal(body.limit, 30);
  assert.equal(body.offset, 0);
  assert.equal(body.items.length, 3);
});

test('each item carries its fandoms, and a fic with none carries an empty list', async () => {
  reset();
  const { body } = await api('/api/fics?sort=title&dir=asc');

  assert.deepEqual(body.items.map((i) => i.fandoms),
    [['Wodehouse'], ['Discworld'], ['Wodehouse']]);
});

test('search matches title, author and tags, on a prefix', async () => {
  reset();

  assert.deepEqual(titles((await api('/api/fics?q=Alph')).body), ['Alpha']);
  assert.deepEqual(titles((await api('/api/fics?q=Bo')).body), ['Beta'], 'by author');
  assert.deepEqual(titles((await api('/api/fics?q=Discworld')).body), ['Beta'], 'by tag');
});

test('search terms are ANDed', async () => {
  reset();
  assert.deepEqual(titles((await api('/api/fics?q=Wodehouse+Epistolary')).body), ['Alpha']);
  assert.equal((await api('/api/fics?q=Wodehouse+Discworld')).body.total, 0);
});

// Search input containing punctuation or FTS5 operators must not cause errors.
test('punctuation and FTS5 operators are searched for, not obeyed', async () => {
  reset();
  for (const q of ['AND', 'NOT', '"', '*', '-', 'a:b', '(', 'OR alpha']) {
    const { status } = await api(`/api/fics?q=${encodeURIComponent(q)}`);
    assert.equal(status, 200, `${q} should not be a syntax error`);
  }
});

test('a search with no searchable term matches nothing, rather than everything', async () => {
  reset();
  const { body } = await api('/api/fics?q=%2B%2B%2B');
  assert.equal(body.total, 0);
});

test('status and favourite narrow the list', async () => {
  const ids = reset();
  applyReadingState(db, ids.beta, { status: 'dropped' });
  setCuration(db, ids.gamma, { favourite: true });

  assert.deepEqual(titles((await api('/api/fics?status=dropped')).body), ['Beta']);
  assert.equal((await api('/api/fics?status=dropped,to_read')).body.total, 3, 'OR within the list');
  assert.deepEqual(titles((await api('/api/fics?favourite=1')).body), ['Gamma']);
});

test('filters combine as AND', async () => {
  const ids = reset();
  setCuration(db, ids.alpha, { favourite: true });
  setCuration(db, ids.beta, { favourite: true });

  assert.deepEqual(titles((await api('/api/fics?favourite=1&q=Wodehouse')).body), ['Alpha']);
});

test('sort and direction are honoured, and an unknown sort falls back', async () => {
  reset();

  assert.deepEqual(titles((await api('/api/fics?sort=word_count&dir=desc')).body),
    ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(titles((await api('/api/fics?sort=word_count&dir=asc')).body),
    ['Beta', 'Alpha', 'Gamma']);
  assert.deepEqual(titles((await api('/api/fics?sort=kudos')).body),
    ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(titles((await api('/api/fics?sort=title&dir=asc')).body),
    ['Alpha', 'Beta', 'Gamma']);

  // Not a column name: the default, not an injection point and not an error.
  assert.equal((await api('/api/fics?sort=word_count;DROP+TABLE+fic')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic').get().c, 3);
});

test('NULLs sort last whichever direction is asked for', async () => {
  reset();
  // Gamma has no updated_at.
  assert.equal(titles((await api('/api/fics?sort=updated_at&dir=desc')).body).at(-1), 'Gamma');
  assert.equal(titles((await api('/api/fics?sort=updated_at&dir=asc')).body).at(-1), 'Gamma');
});

test('paging walks the list without repeating or skipping a row', async () => {
  reset();
  const first = (await api('/api/fics?sort=title&dir=asc&limit=2&offset=0')).body;
  const second = (await api('/api/fics?sort=title&dir=asc&limit=2&offset=2')).body;

  assert.deepEqual(titles(first), ['Alpha', 'Beta']);
  assert.deepEqual(titles(second), ['Gamma']);
  assert.equal(second.total, 3, 'total counts the whole result, not the page');
});

// Two rules, not one: a number out of range is pulled into it, and anything
// that is not a usable number at all falls back to the default page size.
test('limit and offset are clamped to what the endpoint will serve', async () => {
  reset();
  assert.equal((await api('/api/fics?limit=9999')).body.limit, 100, 'clamped down');
  assert.equal((await api('/api/fics?limit=-5')).body.limit, 1, 'clamped up');
  assert.equal((await api('/api/fics?limit=0')).body.limit, 30, 'zero is not a page');
  assert.equal((await api('/api/fics?limit=abc')).body.limit, 30);
  assert.equal((await api('/api/fics?offset=-5')).body.offset, 0);
});

test('GET /api/fics/:id returns one fic with its tags grouped', async () => {
  const ids = reset();
  const { status, body } = await api(`/api/fics/${ids.alpha}`);

  assert.equal(status, 200);
  assert.equal(body.title, 'Alpha');
  assert.deepEqual(body.tags.fandom, ['Wodehouse']);
  assert.deepEqual(body.tags.freeform, ['Epistolary']);
  assert.deepEqual(body.tags.character, [], 'every group is present, even empty');
});

test('GET /api/fics/:id for a fic that is not there is a 404', async () => {
  reset();
  const { status, body } = await api('/api/fics/9999');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

test('GET /api/meta counts fics by status', async () => {
  const ids = reset();
  applyReadingState(db, ids.beta, { status: 'dropped' });

  const { body } = await api('/api/meta');
  const counts = Object.fromEntries(body.status_counts.map((r) => [r.status, r.c]));
  assert.deepEqual(counts, { to_read: 2, dropped: 1 });
});

test('PATCH sets a status and hands back the updated fic', async () => {
  const ids = reset();
  const { status, body } = await patch(ids.alpha, { status: 'read' });

  assert.equal(status, 200);
  assert.equal(body.status, 'read');
  assert.equal(body.state_source, 'user');
  assert.ok(body.tags, 'the response is the full fic, as GET gives it');
});

test('PATCH sets a chapter and lets the status follow from it', async () => {
  const ids = reset();
  const { body } = await patch(ids.alpha, { chapter: 4 });

  assert.equal(body.chapter, 4);
  assert.equal(body.status, 'read', 'the last chapter of a finished work');
  assert.equal(body.state_source, 'import');
});

test('PATCH sets a favourite and a note', async () => {
  const ids = reset();

  const { status, body } = await patch(ids.alpha, { favourite: true, note: 'For the letters.' });
  assert.equal(status, 200);
  assert.equal(body.favourite, 1);
  assert.equal(body.note, 'For the letters.');

  assert.equal((await patch(ids.alpha, { note: null })).body.note, null);
  assert.equal((await patch(ids.alpha, { favourite: false })).body.favourite, 0);
});

test('curating a fic never moves its reading state', async () => {
  const ids = reset();
  await patch(ids.alpha, { status: 'dropped' });
  const { body } = await patch(ids.alpha, { favourite: true });

  assert.equal(body.status, 'dropped');
  assert.equal(body.state_source, 'user', 'a favourite is not a verdict on reading it');
});

test('a rejected PATCH names a cause the caller can act on', async () => {
  const ids = reset();
  const cases = [
    [{}, 400, 'empty_patch'],
    [{ status: 'finished' }, 400, 'bad_status'],
    [{ chapter: 0 }, 400, 'bad_chapter'],
    [{ chapter: 99 }, 400, 'bad_chapter'],
    [{ chapter: 1.5 }, 400, 'bad_chapter'],
    [{ chapter: '2' }, 400, 'bad_chapter'],
    [{ favourite: 'yes' }, 400, 'bad_favourite'],
    [{ favourite: 1 }, 400, 'bad_favourite'],
    [{ note: 42 }, 400, 'bad_note'],
  ];

  for (const [body, status, error] of cases) {
    const got = await patch(ids.alpha, body);
    assert.equal(got.status, status, JSON.stringify(body));
    assert.equal(got.body.error, error, JSON.stringify(body));
    assert.ok(got.body.message, 'an error carries something to show the reader');
  }
});

test('a rejected PATCH leaves the row exactly as it was', async () => {
  const ids = reset();
  const before = (await api(`/api/fics/${ids.alpha}`)).body;

  await patch(ids.alpha, { status: 'read', chapter: 99 });

  assert.deepEqual((await api(`/api/fics/${ids.alpha}`)).body, before,
    'the valid half of an invalid patch must not land either');
});

test('a series has no chapter to set', async () => {
  reset();
  const { id } = upsertFic(
    db,
    { slug: 'series/9', url: 'https://archiveofourown.org/series/9' },
    work({ kind: 'series', chapters_done: null, chapter_ids: [] }),
  );

  assert.equal((await patch(id, { chapter: 2 })).body.error, 'bad_chapter');
  assert.equal((await patch(id, { status: 'read' })).status, 200, 'but it can be read');
});

test('PATCHing a fic that is not there is a 404, whatever the patch says', async () => {
  reset();
  assert.equal((await patch(9999, { status: 'read' })).status, 404);
});

test('a malformed body is reported as such, not as a 500', async () => {
  const ids = reset();
  const { status, body } = await patch(ids.alpha, '{not json');

  assert.equal(status, 400);
  assert.equal(body.error, 'bad_body');
});

test('POST /api/import rejects a non-AO3 link before reaching the network', async () => {
  reset();
  const { status, body } = await api('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/works/1' }),
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'bad_url');
});

test('POST /api/import with no url at all is a bad url, not a crash', async () => {
  reset();
  const { status, body } = await api('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'bad_url');
});

test('/api/import is POST only', async () => {
  reset();
  assert.equal((await api('/api/import')).status, 405);
});

test('an unknown /api/ path is a 404 rather than the index page', async () => {
  reset();
  const { status, body } = await api('/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

test('/ serves the app, and a missing static file is a 404', async () => {
  reset();
  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /<title>/);

  const css = await fetch(`${origin}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  assert.equal((await fetch(`${origin}/nope.js`)).status, 404);
});

test('a traversal out of public/ is refused', async () => {
  reset();
  // Raw, because fetch() collapses ../ in the client, so these would never
  // leave as written. What actually stops them is the WHATWG URL parser: it
  // resolves every dot segment, %2e%2e included, before serveStatic sees a
  // pathname. The prefix check there is a second line that nothing reaches.
  // This pins the property, not either mechanism.
  for (const path of ['/../package.json', '/../../etc/passwd', '/..%2fpackage.json',
                      '/%2e%2e/.env', '/./../.env']) {
    const raw = await rawGet(path);
    assert.match(raw, /^HTTP\/1\.1 (403|404) /, `${path} was served`);
    assert.ok(!raw.includes('an-archive-of-your-own'), `${path} leaked a file outside public/`);
    assert.ok(!raw.includes('AO3_SESSION'), `${path} leaked a file outside public/`);
  }
});
