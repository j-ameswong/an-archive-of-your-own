import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from './import.js';

const WORK = {
  kind: 'work',
  slug: 'works/6623293',
  url: 'https://archiveofourown.org/works/6623293',
  chapter_id: null,
};
const SERIES = {
  kind: 'series',
  slug: 'series/1637290',
  url: 'https://archiveofourown.org/series/1637290',
  chapter_id: null,
};
// Same record, but the link names a chapter: where the reader stopped.
const AT_CHAPTER = { ...WORK, chapter_id: '15155914' };

// Every link that names the same record must collapse to the same slug.
const ACCEPTED = [
  ['https://archiveofourown.org/works/6623293', WORK],
  ['http://archiveofourown.org/works/6623293', WORK],
  ['https://www.archiveofourown.org/works/6623293', WORK],
  ['archiveofourown.org/works/6623293', WORK],
  ['  https://archiveofourown.org/works/6623293  ', WORK],
  ['https://archiveofourown.org/works/6623293/', WORK],
  ['https://ARCHIVEOFOUROWN.ORG/works/6623293', WORK],
  ['https://archiveofourown.org/works/6623293?view_adult=true', WORK],
  ['https://archiveofourown.org/works/6623293#workskin', WORK],
  ['https://archiveofourown.org/works/6623293/navigate', WORK],
  // AO3 serves works nested under a collection they belong to.
  ['https://archiveofourown.org/collections/Snakebois/works/6623293', WORK],
  ['https://archiveofourown.org/series/1637290', SERIES],
  ['https://archiveofourown.org/series/1637290?page=2', SERIES],
];

const REJECTED = [
  ['', 'empty'],
  ['   ', 'whitespace'],
  [null, 'null'],
  [undefined, 'undefined'],
  [42, 'non-string'],
  ['not a url', 'garbage'],
  ['https://example.com/works/6623293', 'non-AO3 host'],
  ['https://www.fanfiction.net/s/6623293', 'another fic site'],
  // Lookalike hosts must not slip through a substring check.
  ['https://archiveofourown.org.evil.com/works/6623293', 'suffixed host'],
  ['https://notarchiveofourown.org/works/6623293', 'prefixed host'],
  ['ftp://archiveofourown.org/works/6623293', 'non-http scheme'],
  ['javascript:alert(1)', 'javascript scheme'],
  ['https://archiveofourown.org/works', 'work index, no id'],
  ['https://archiveofourown.org/works?complete=T', 'filtered index'],
  ['https://archiveofourown.org/works/abc', 'non-numeric id'],
  ['https://archiveofourown.org/users/Puzzled', 'user page'],
  ['https://archiveofourown.org/tags/Time%20Travel/works', 'tag page'],
  ['https://archiveofourown.org/collections/Snakebois', 'collection page'],
  ['https://archiveofourown.org/', 'site root'],
];

// A chapter link still collapses to the work's slug -- it is the same record --
// but the chapter id survives, because it is the reader's position in it.
const AT_CHAPTER_LINKS = [
  'https://archiveofourown.org/works/6623293/chapters/15155914',
  'https://archiveofourown.org/works/6623293/chapters/15155914/',
  'https://archiveofourown.org/works/6623293/chapters/15155914?view_adult=true',
  'https://archiveofourown.org/works/6623293/chapters/15155914#workskin',
  'https://archiveofourown.org/collections/Snakebois/works/6623293/chapters/15155914',
  'archiveofourown.org/works/6623293/chapters/15155914',
];

test('accepts every form of an AO3 work or series link', () => {
  for (const [input, expected] of ACCEPTED) {
    assert.deepEqual(normalizeUrl(input), expected, `input: ${input}`);
  }
});

test('rejects anything that is not an AO3 work or series link', () => {
  for (const [input, why] of REJECTED) {
    assert.equal(normalizeUrl(input), null, `should reject ${why}: ${input}`);
  }
});

test('normalizing an already-normalized url is a no-op', () => {
  for (const expected of [WORK, SERIES]) {
    assert.deepEqual(normalizeUrl(expected.url), expected);
  }
});

test('a chapter link keeps the chapter id and still collapses to the work slug', () => {
  for (const input of AT_CHAPTER_LINKS) {
    assert.deepEqual(normalizeUrl(input), AT_CHAPTER, `input: ${input}`);
  }
});

test('a link with no chapter carries no position', () => {
  assert.equal(normalizeUrl(WORK.url).chapter_id, null);
  assert.equal(normalizeUrl(`${WORK.url}/navigate`).chapter_id, null);
  // A series has no chapters of its own, however the path is written.
  assert.equal(normalizeUrl(`${SERIES.url}/chapters/15155914`).chapter_id, null);
});
