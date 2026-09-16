import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWork, parseSeries, TAG_TYPES } from './parse.js';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8');

test('a finished multi-chapter work', () => {
  const w = parseWork(fixture('work-complete-6623293'));
  assert.deepEqual({ ...w, tags: undefined }, {
    kind: 'work',
    title: 'Realignment',
    author: 'Puzzled',
    author_url: 'https://archiveofourown.org/users/Puzzled/pseuds/Puzzled',
    summary:
      'The year is 1943. The Chamber lies unopened and Grindlewald roams unchecked. ' +
      'Neither Tom Riddle nor Albus Dumbledore is satisfied with the situation. ' +
      "Luckily when Hogwarts is attacked they'll both have other things to worry about.",
    word_count: 65871,
    chapters_done: 25,
    chapters_total: 25,
    is_complete: 1,
    rating: 'Teen And Up Audiences',
    published_at: '2016-04-22',
    updated_at: '2018-07-26',
    kudos: 534,
    bookmarks: 244,
    tags: undefined,
  });
});

test('tags come back grouped, in page order, with rating kept out', () => {
  const { tags, rating } = parseWork(fixture('work-complete-6623293'));
  assert.deepEqual(tags, {
    fandom: ['Harry Potter - J. K. Rowling'],
    relationship: [],
    character: ['Harry Potter', 'Tom Riddle', 'Gellert Grindelwald', 'Albus Dumbledore'],
    freeform: ['Time Travel', 'World War II', 'Nazis'],
    category: ['Gen'],
    warning: ['Creator Chose Not To Use Archive Warnings'],
  });
  // Rating is a single column on fic, not one of the tag rows.
  assert.equal(rating, 'Teen And Up Audiences');
  assert.ok(!Object.keys(tags).includes('rating'));
  assert.deepEqual(Object.keys(tags), TAG_TYPES);
});

test('a one-shot finished the day it was posted has no status row', () => {
  const w = parseWork(fixture('work-oneshot-3694820'));
  assert.equal(w.chapters_done, 1);
  assert.equal(w.chapters_total, 1);
  // Every promised chapter is posted, so the work is finished -- even though
  // AO3 prints no "Completed:" line to say so.
  assert.equal(w.is_complete, 1);
  assert.equal(w.published_at, '2015-04-06');
  // With no status row, "last updated" can only be the publication date.
  assert.equal(w.updated_at, '2015-04-06');
});

test('a restricted work still parses; the lock icon is not part of the title', () => {
  const w = parseWork(fixture('work-oneshot-3694820'));
  assert.equal(w.title, 'Charlotte the Great and Powerful');
});

test('an undeclared chapter total reads as null, not zero', () => {
  const w = parseWork(fixture('work-ongoing-47011165'));
  assert.equal(w.chapters_done, 11);
  assert.equal(w.chapters_total, null);
  assert.equal(w.is_complete, 0);
});

test('non-ascii names and entities survive decoding', () => {
  const w = parseWork(fixture('work-ongoing-47011165'));
  assert.equal(w.author, 'リリス - riris (arurun)');
  assert.equal(w.title, 'beware the dust devil.');
});

test('html entities decode; unknown ones are left alone', () => {
  const html =
    '<dl class="work meta group"></dl>' +
    '<h2 class="title heading">A&rsquo;B &mdash; C&hellip; &amp; D &#8594; &#x2192; &notarealentity;</h2>';
  assert.equal(parseWork(html).title, 'A\u2019B \u2014 C\u2026 & D \u2192 \u2192 &notarealentity;');
});

test('co-authors are joined, keeping the first author url', () => {
  const w = parseWork(fixture('work-coauthored-20631227'));
  assert.equal(w.author, 'daisyridlay, sharkdododo');
  assert.equal(w.author_url, 'https://archiveofourown.org/users/daisyridlay/pseuds/daisyridlay');
});

test('a summary is flattened to one line of text', () => {
  const { summary } = parseWork(fixture('work-oneshot-3694820'));
  assert.ok(!/[\n<>]/.test(summary), 'no markup or newlines');
  assert.ok(!/ {2}/.test(summary), 'no double spaces');
  assert.match(summary, /^Her whole life has been about gaining power/);
  assert.match(summary, /not above using others to gain power\.$/);
});

test('a series', () => {
  const s = parseSeries(fixture('series-1637290'));
  assert.deepEqual(s, {
    kind: 'series',
    title: 'Mutatum',
    author: 'Vichan',
    author_url: 'https://archiveofourown.org/users/Vichan/pseuds/Vichan',
    summary:
      'Mutatum - altered, changed, modified, having been transformed. ' +
      '1. Evitative - grammatically expressing the notion that something is avoided or feared ' +
      '2. Redivider - something that divides or apportions again 3. TBA',
    // A series page states none of these.
    word_count: 329946,
    chapters_done: null,
    chapters_total: null,
    is_complete: 0,
    rating: null,
    published_at: '2019-07-31',
    updated_at: '2025-09-01',
    kudos: null,
    bookmarks: 6417,
    tags: { fandom: [], relationship: [], character: [], freeform: [], category: [], warning: [] },
  });
});

test('series parsing ignores the work listing below the metadata', () => {
  const s = parseSeries(fixture('series-1637290'));
  // The page lists works by the same creator; only the series creator counts.
  assert.equal(s.author, 'Vichan');
  assert.equal(s.title, 'Mutatum');
});

test('a page with no metadata block throws rather than returning nulls', () => {
  assert.throws(() => parseWork('<html><body>logged out</body></html>'), /no work meta block/);
  assert.throws(() => parseSeries('<html><body>logged out</body></html>'), /no series meta block/);
  // A series page is not a work page, and vice versa.
  assert.throws(() => parseWork(fixture('series-1637290')), /no work meta block/);
  assert.throws(() => parseSeries(fixture('work-complete-6623293')), /no series meta block/);
});
