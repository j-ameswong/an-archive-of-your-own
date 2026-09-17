import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { upsertFic, recordFetchFailure, deriveStatus } from './store.js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

const TARGET = { slug: 'works/123', url: 'https://archiveofourown.org/works/123' };

const record = (over = {}) => ({
  kind: 'work',
  title: 'A Work',
  author: 'Someone',
  author_url: 'https://archiveofourown.org/users/Someone/pseuds/Someone',
  summary: 'A summary.',
  word_count: 1000,
  chapters_done: 2,
  chapters_total: 2,
  is_complete: 1,
  rating: 'General Audiences',
  published_at: '2020-01-01',
  updated_at: '2020-02-01',
  kudos: 10,
  bookmarks: 3,
  tags: { fandom: ['Fandom A'], character: ['Char A', 'Char B'], freeform: ['Tag A'] },
  ...over,
});

const search = (db, match) =>
  db.prepare('SELECT rowid FROM fic_fts WHERE fic_fts MATCH ?').all(match).map((r) => r.rowid);

test('a new fic arrives as unread, marked as coming from an import', () => {
  const db = freshDb();
  const { id, created } = upsertFic(db, TARGET, record());
  assert.equal(created, true);

  const row = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  assert.equal(row.slug, 'works/123');
  assert.equal(row.url, TARGET.url);
  assert.equal(row.kind, 'work');
  assert.equal(row.title, 'A Work');
  assert.equal(row.word_count, 1000);
  assert.equal(row.status, 'to_read');
  assert.equal(row.state_source, 'import');
  assert.equal(row.favourite, 0);
  assert.equal(row.fetch_status, 'ok');
  assert.equal(row.fetch_error, null);
  assert.ok(row.enriched_at, 'enriched_at is stamped');
});

test('re-importing leaves curation and reading state alone', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());

  // Stand in for the reader having lived with this fic for a while.
  db.prepare(
    `UPDATE fic SET note = 'my note', favourite = 1, status = 'unfinished',
                    chapter = 7, resume_url = 'https://example.com/ch7',
                    last_read_at = '2021-06-01', state_source = 'user',
                    state_changed_at = '2021-06-01T00:00:00Z'
     WHERE id = ?`
  ).run(id);

  const before = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  upsertFic(db, TARGET, record({ title: 'A Work (revised)', word_count: 2500, kudos: 99 }));
  const after = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);

  for (const col of [
    'note', 'favourite', 'status', 'chapter', 'resume_url',
    'last_read_at', 'state_source', 'state_changed_at',
  ]) {
    assert.equal(after[col], before[col], `${col} must survive a re-import`);
  }

  // ...while the upstream facts do move.
  assert.equal(after.title, 'A Work (revised)');
  assert.equal(after.word_count, 2500);
  assert.equal(after.kudos, 99);
});

test('re-importing updates in place rather than inserting again', () => {
  const db = freshDb();
  const first = upsertFic(db, TARGET, record());
  const second = upsertFic(db, TARGET, record({ kudos: 50 }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic').get().c, 1);
});

test('tags are replaced, not merged', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());
  upsertFic(db, TARGET, record({ tags: { fandom: ['Fandom B'], freeform: ['Tag B'] } }));

  const tags = db
    .prepare('SELECT tag_type, tag FROM fic_tag WHERE fic_id = ? ORDER BY tag_type, tag')
    .all(id)
    .map((r) => `${r.tag_type}:${r.tag}`);
  assert.deepEqual(tags, ['fandom:Fandom B', 'freeform:Tag B']);
});

test('a tag repeated within its type is stored once', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record({ tags: { fandom: ['Dup', 'Dup'] } }));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM fic_tag WHERE fic_id = ?').get(id).c,
    1
  );
});

test('the search index follows the row', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());
  assert.deepEqual(search(db, '"Work"*'), [id]);
  assert.deepEqual(search(db, '"Char"*'), [id], 'tags are indexed');

  upsertFic(db, TARGET, record({ title: 'Renamed', tags: { fandom: ['Elsewhere'] } }));
  assert.deepEqual(search(db, '"Renamed"*'), [id]);
  assert.deepEqual(search(db, '"Elsewhere"*'), [id]);
  // The stale entry is gone rather than sitting alongside the new one.
  assert.deepEqual(search(db, '"Char"*'), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic_fts').get().c, 1);
});

test('a series stores nulls where a series page says nothing', () => {
  const db = freshDb();
  const target = { slug: 'series/9', url: 'https://archiveofourown.org/series/9' };
  const { id } = upsertFic(db, target, {
    kind: 'series',
    title: 'A Series',
    author: 'Someone',
    author_url: null,
    summary: 'Series description.',
    word_count: 5000,
    chapters_done: null,
    chapters_total: null,
    is_complete: 0,
    rating: null,
    published_at: '2020-01-01',
    updated_at: '2021-01-01',
    kudos: null,
    bookmarks: 12,
    tags: {},
  });

  const row = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  assert.equal(row.kind, 'series');
  assert.equal(row.chapters_done, null);
  assert.equal(row.rating, null);
  assert.equal(row.kudos, null);
  assert.equal(row.bookmarks, 12);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic_tag WHERE fic_id = ?').get(id).c, 0);
  assert.deepEqual(search(db, '"Series"*'), [id]);
});

test('a failed write leaves nothing behind', () => {
  const db = freshDb();
  // undefined cannot be bound, so the tag insert fails after fic is written.
  assert.throws(() => upsertFic(db, TARGET, record({ tags: { fandom: [undefined] } })));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic_tag').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic_fts').get().c, 0);
});

test('a failed write does not damage the row it was refreshing', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());
  assert.throws(() =>
    upsertFic(db, TARGET, record({ title: 'Half written', tags: { fandom: [undefined] } }))
  );
  const row = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  assert.equal(row.title, 'A Work');
  assert.deepEqual(search(db, '"Work"*'), [id]);
});

test('a fetch failure is recorded without touching the stored facts', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());
  const before = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);

  assert.equal(recordFetchFailure(db, TARGET.slug, 'missing', 'HTTP 404'), true);

  const after = db.prepare('SELECT * FROM fic WHERE id = ?').get(id);
  assert.equal(after.fetch_status, 'missing');
  assert.equal(after.fetch_error, 'HTTP 404');
  assert.equal(after.title, before.title);
  assert.equal(after.word_count, before.word_count);
  assert.equal(after.kudos, before.kudos);
});

test('a later success clears the recorded failure', () => {
  const db = freshDb();
  upsertFic(db, TARGET, record());
  recordFetchFailure(db, TARGET.slug, 'error', 'HTTP 500');
  upsertFic(db, TARGET, record());
  const row = db.prepare('SELECT * FROM fic WHERE slug = ?').get(TARGET.slug);
  assert.equal(row.fetch_status, 'ok');
  assert.equal(row.fetch_error, null);
});

test('a fetch failure for an unknown fic creates nothing', () => {
  const db = freshDb();
  assert.equal(recordFetchFailure(db, 'works/does-not-exist', 'missing'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fic').get().c, 0);
});

test('writes survive a last_insert_rowid beyond the safe integer range', () => {
  const db = freshDb();
  const { id } = upsertFic(db, TARGET, record());

  // fts5 holds its index in shadow tables whose rowids run past
  // Number.MAX_SAFE_INTEGER once the index has any real content. node:sqlite
  // reports last_insert_rowid() after every run(), so in that state an ordinary
  // statement throws before doing anything useful. Force it here; a real
  // database gets there on its own.
  const outOfRange = db.prepare('INSERT INTO fic_fts (rowid, title) VALUES (?, ?)');
  outOfRange.setReadBigInts(true);
  outOfRange.run(BigInt(Number.MAX_SAFE_INTEGER) + 100n, 'out of range');

  assert.throws(
    () => db.prepare('UPDATE fic SET title = ? WHERE id = ?').run('x', id),
    { name: 'RangeError' },
    'precondition: a plain statement cannot run in this state'
  );

  assert.doesNotThrow(() => upsertFic(db, TARGET, record({ title: 'Still works' })));
  assert.equal(db.prepare('SELECT title FROM fic WHERE id = ?').get(id).title, 'Still works');
  assert.deepEqual(search(db, '"Still"*'), [id]);

  assert.doesNotThrow(() => recordFetchFailure(db, TARGET.slug, 'error', 'later'));
  assert.equal(db.prepare('SELECT fetch_status FROM fic WHERE id = ?').get(id).fetch_status, 'error');
});

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

test('status follows how far the reader got', () => {
  const cases = [
    // chapter, chapters_done, is_complete, expected
    [null, 11, 0, 'to_read', 'a bare link carries no position'],
    [1, 1, 1, 'to_read', 'a oneshot is opened, not finished'],
    [1, 5, 1, 'to_read', 'chapter one is opened, not started'],
    [2, 5, 1, 'unfinished', 'past the first chapter, short of the last'],
    [7, 11, 0, 'unfinished', 'partway through a running fic'],
    [11, 11, 0, 'caught_up', 'every posted chapter read, more to come'],
    [25, 25, 1, 'read', 'every chapter read and the author is done'],
    [12, 11, 0, 'caught_up', 'a chapter past the count is still caught up'],
    [2, null, 0, 'unfinished', 'a series has no count to be caught up with'],
  ];
  for (const [chapter, chapters_done, is_complete, expected, why] of cases) {
    assert.equal(deriveStatus({ chapter, chapters_done, is_complete }), expected, why);
  }
});

// The ids a work's chapter menu would carry, for a work of n chapters.
const menu = (n) => Array.from({ length: n }, (_, i) => String(9000 + i));
const at = (chapterId) => ({ ...TARGET, chapter_id: chapterId });

test('a chapter link sets the chapter, the resume link and the status', () => {
  const db = freshDb();
  upsertFic(db, at('9006'), record({ chapters_done: 11, chapters_total: 20,
    is_complete: 0, chapter_ids: menu(11) }));

  const fic = db.prepare('SELECT * FROM fic WHERE slug = ?').get(TARGET.slug);
  assert.equal(fic.chapter, 7, 'position in the menu, not the id');
  assert.equal(fic.resume_url, 'https://archiveofourown.org/works/123/chapters/9006');
  assert.equal(fic.status, 'unfinished');
  assert.equal(fic.state_source, 'import');
});

test('the last posted chapter is caught_up while the author is still writing', () => {
  const db = freshDb();
  upsertFic(db, at('9010'), record({ chapters_done: 11, chapters_total: null,
    is_complete: 0, chapter_ids: menu(11) }));
  assert.equal(db.prepare('SELECT status FROM fic').get().status, 'caught_up');
});

test('the last chapter of a finished work is read', () => {
  const db = freshDb();
  upsertFic(db, at('9024'), record({ chapters_done: 25, chapters_total: 25,
    is_complete: 1, chapter_ids: menu(25) }));
  assert.equal(db.prepare('SELECT status FROM fic').get().status, 'read');
});

test('a oneshot has no chapter menu, and being on it is not finishing it', () => {
  const db = freshDb();
  upsertFic(db, at('9000'), record({ chapters_done: 1, chapters_total: 1,
    is_complete: 1, chapter_ids: [] }));
  const fic = db.prepare('SELECT * FROM fic').get();
  assert.equal(fic.chapter, 1, 'the only chapter there is');
  assert.equal(fic.status, 'to_read');
});

test('a chapter the work no longer lists leaves no position behind', () => {
  const db = freshDb();
  upsertFic(db, at('4242'), record({ chapters_done: 11, chapters_total: 20,
    is_complete: 0, chapter_ids: menu(11) }));
  const fic = db.prepare('SELECT * FROM fic').get();
  assert.equal(fic.chapter, null);
  assert.equal(fic.resume_url, null, 'a link we cannot place is not a resume link');
  assert.equal(fic.status, 'to_read');
});

test('re-importing a deeper chapter link records the progress', () => {
  const db = freshDb();
  const ongoing = (over) => record({ chapters_done: 11, chapters_total: null,
    is_complete: 0, chapter_ids: menu(11), ...over });

  upsertFic(db, at('9006'), ongoing());
  upsertFic(db, at('9010'), ongoing());

  const fic = db.prepare('SELECT * FROM fic').get();
  assert.equal(fic.chapter, 11);
  assert.equal(fic.resume_url, 'https://archiveofourown.org/works/123/chapters/9010');
  assert.equal(fic.status, 'caught_up');
});

test('re-importing a bare link leaves reading state exactly as it was', () => {
  const db = freshDb();
  const ongoing = record({ chapters_done: 11, chapters_total: null,
    is_complete: 0, chapter_ids: menu(11) });

  upsertFic(db, at('9006'), ongoing);
  const before = db.prepare('SELECT * FROM fic').get();

  // The facts move on -- the author posted a twelfth chapter -- but a bare
  // paste says nothing about where the reader is.
  upsertFic(db, TARGET, record({ chapters_done: 12, chapters_total: null,
    is_complete: 0, chapter_ids: menu(12), word_count: 99999 }));
  const after = db.prepare('SELECT * FROM fic').get();

  assert.equal(after.word_count, 99999, 'facts still refresh');
  assert.equal(after.chapter, before.chapter);
  assert.equal(after.resume_url, before.resume_url);
  assert.equal(after.status, before.status);
  assert.equal(after.state_changed_at, before.state_changed_at);
});

test('an import never overwrites a status the reader set by hand', () => {
  const db = freshDb();
  const ongoing = record({ chapters_done: 11, chapters_total: null,
    is_complete: 0, chapter_ids: menu(11) });
  upsertFic(db, at('9006'), ongoing);

  // The reader gave up on it.
  db.prepare("UPDATE fic SET status = 'dropped', state_source = 'user'").run();

  // Later they paste a link to the last chapter anyway.
  upsertFic(db, at('9010'), ongoing);

  const fic = db.prepare('SELECT * FROM fic').get();
  assert.equal(fic.status, 'dropped', 'their word stands');
  assert.equal(fic.state_source, 'user');
  assert.equal(fic.chapter, 11, 'but where they are is still a fact');
  assert.equal(fic.resume_url, 'https://archiveofourown.org/works/123/chapters/9010');
});
