// Turning an AO3 page into a fic row.
//
// Reads only the metadata block at the top of a page -- <dl class="work meta
// group"> or <dl class="series meta group"> -- never the fic body. A page with
// no meta block throws, so a markup change upstream surfaces as a fetch error
// rather than quietly overwriting good rows with nulls.

export const TAG_TYPES = [
  'fandom',
  'relationship',
  'character',
  'freeform',
  'category',
  'warning',
];

// AO3 serves UTF-8, so most punctuation arrives as characters rather than
// entities, but author-entered markup can carry either. Anything not listed is
// left alone rather than guessed at.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
};

function decodeEntities(s) {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body] ?? whole;
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

// Summaries and descriptions arrive as paragraph markup; fic.summary is flat
// text, so tags become spaces and runs of whitespace collapse.
function text(html) {
  if (html == null) return null;
  const flat = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return flat || null;
}

function number(value) {
  if (value == null) return null;
  const digits = value.replace(/,/g, '').match(/\d+/);
  return digits ? Number(digits[0]) : null;
}

function absolute(href) {
  if (!href) return null;
  try {
    return new URL(href, 'https://archiveofourown.org').href;
  } catch {
    return null;
  }
}

// <dt>/<dd> pairs as flat text, keyed by label. A <dd> is read up to the next
// <dt> rather than to its own </dd>: AO3 nests the stats list inside one, and
// this way the nested labels come back as pairs of their own instead of being
// swallowed.
function definitions(html) {
  const out = new Map();
  const dt = /<dt[^>]*>([\s\S]*?)<\/dt>/g;
  let m;
  while ((m = dt.exec(html)) !== null) {
    const label = text(m[1])?.replace(/:$/, '');
    const rest = html.slice(dt.lastIndex);
    const dd = /^\s*<dd[^>]*>/.exec(rest);
    if (!label || !dd) continue;
    const body = rest.slice(dd[0].length);
    const next = body.search(/<dt[^>]*>/);
    out.set(label, text(next === -1 ? body : body.slice(0, next)));
  }
  return out;
}

const AUTHOR_LINK = /<a\b([^>]*\brel="author"[^>]*)>([\s\S]*?)<\/a>/g;

// A work or series can have several creators; fic stores the names joined and
// keeps the first one's url. Deleted and anonymous creators have no link.
function creators(regionHtml) {
  if (regionHtml == null) return { author: null, author_url: null };
  const links = [...regionHtml.matchAll(AUTHOR_LINK)];
  if (links.length === 0) return { author: text(regionHtml), author_url: null };
  const names = links.map((l) => text(l[2])).filter(Boolean);
  return {
    author: names.length ? names.join(', ') : null,
    author_url: absolute(/\bhref="([^"]*)"/.exec(links[0][1])?.[1]),
  };
}

function emptyTags() {
  return Object.fromEntries(TAG_TYPES.map((t) => [t, []]));
}

function tagList(regionHtml, type) {
  const dd = new RegExp(`<dd class="${type} tags">([\\s\\S]*?)<\\/dd>`).exec(regionHtml);
  if (!dd) return [];
  return [...dd[1].matchAll(/<a\b[^>]*class="tag"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => text(m[1]))
    .filter(Boolean);
}

function firstMatch(html, re) {
  return text(re.exec(html)?.[1]);
}

/**
 * @param {string} html an AO3 work page
 * @returns a fic row, with tags grouped by type
 * @throws if the page carries no work metadata block
 */
export function parseWork(html) {
  const metaStart = html.indexOf('<dl class="work meta group">');
  if (metaStart === -1) throw new Error('no work meta block');

  // The stats list sits inside the meta list; tags are all above it.
  const statsStart = html.indexOf('<dl class="stats">', metaStart);
  const tagsRegion = html.slice(metaStart, statsStart === -1 ? undefined : statsStart);
  const stats = definitions(
    statsStart === -1 ? '' : /<dl class="stats">([\s\S]*?)<\/dl>/.exec(html.slice(statsStart))?.[1] ?? ''
  );

  const [done, total] = (stats.get('Chapters') ?? '').split('/');
  const chaptersDone = number(done);
  // "?" is AO3 for "the author has not declared a total".
  const chaptersTotal = total === '?' ? null : number(total);

  const published = stats.get('Published') ?? null;
  // The same row is labelled "Completed:" or "Updated:", and is left out
  // entirely when a work was finished the day it was posted.
  const updated = stats.get('Completed') ?? stats.get('Updated') ?? published;

  return {
    kind: 'work',
    title: firstMatch(html, /<h2 class="title heading">([\s\S]*?)<\/h2>/),
    ...creators(/<h3 class="byline heading">([\s\S]*?)<\/h3>/.exec(html)?.[1]),
    summary: firstMatch(
      html,
      /<div class="summary module">[\s\S]*?<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/
    ),
    word_count: number(stats.get('Words')),
    chapters_done: chaptersDone,
    chapters_total: chaptersTotal,
    // A work is finished when every chapter the author promised is posted.
    is_complete: chaptersTotal !== null && chaptersDone === chaptersTotal ? 1 : 0,
    rating: tagList(tagsRegion, 'rating')[0] ?? null,
    published_at: published,
    updated_at: updated,
    kudos: number(stats.get('Kudos')),
    bookmarks: number(stats.get('Bookmarks')),
    tags: Object.fromEntries(TAG_TYPES.map((t) => [t, tagList(tagsRegion, t)])),
  };
}

/**
 * @param {string} html an AO3 series page
 * @returns a fic row. Series pages carry no rating, kudos, chapter counts or
 *   full tag lists, so those come back null or empty.
 * @throws if the page carries no series metadata block
 */
export function parseSeries(html) {
  const metaStart = html.indexOf('<dl class="series meta group">');
  if (metaStart === -1) throw new Error('no series meta block');

  // Stop before the work listing: each blurb has its own byline and stats.
  const listStart = html.indexOf('<ul class="series work index group"', metaStart);
  const meta = html.slice(metaStart, listStart === -1 ? undefined : listStart);
  const fields = definitions(meta);

  const published = fields.get('Series Begun') ?? null;

  return {
    kind: 'series',
    title: firstMatch(html.slice(html.indexOf('series-show')), /<h2 class="heading">([\s\S]*?)<\/h2>/),
    ...creators(/<dt[^>]*>\s*Creator:\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/.exec(meta)?.[1]),
    summary: fields.get('Description') ?? null,
    word_count: number(fields.get('Words')),
    chapters_done: null,
    chapters_total: null,
    is_complete: /^yes$/i.test(fields.get('Complete') ?? '') ? 1 : 0,
    rating: null,
    published_at: published,
    updated_at: fields.get('Series Updated') ?? published,
    kudos: null,
    bookmarks: number(fields.get('Bookmarks')),
    tags: emptyTags(),
  };
}
