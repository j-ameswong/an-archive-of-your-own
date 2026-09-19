// Turning a pasted AO3 link into a database key.
//
// `fic.slug` is the unique key, so every link that names the same work has to
// collapse to the same string: chapter deep links, ?view_adult=true, the
// collection-scoped path AO3 uses when a work is in a collection, #workskin.

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

// An optional /collections/<name> prefix, then works|series and the id.
// Anything after the id -- /navigate, /comments -- is a view of the same record
// and is dropped. /chapters/456 is kept separately: it is not part of the
// record's identity, but it is where the reader stopped.
const AO3_PATH =
  /^(?:\/collections\/[^/]+)?\/(works|series)\/(\d+)(?:\/chapters\/(\d+))?(?:\/.*)?$/;

/**
 * @returns {{kind: 'work'|'series', slug: string, url: string,
 *   chapter_id: string|null} | null}
 *   null for anything that is not an AO3 work or series link. chapter_id is
 *   AO3's global chapter id, which says nothing about position on its own --
 *   only the chapter list on the fetched page can turn it into a number.
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Accept a bare "archiveofourown.org/works/123" paste. Guard against the
  // scheme-relative "//host/path", which URL would resolve against https:.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')
    ? trimmed
    : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!AO3_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = AO3_PATH.exec(url.pathname.replace(/\/+$/, ''));
  if (!match) return null;

  const [, collection, id, chapterId] = match;
  const slug = `${collection}/${id}`;
  const kind = collection === 'works' ? 'work' : 'series';

  return {
    kind,
    slug,
    url: `https://archiveofourown.org/${slug}`,
    // Series have no chapters of their own; a series page never links one.
    chapter_id: kind === 'work' ? chapterId ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Requests run one at a time, five seconds apart by default.
// Tests override the interval to avoid waiting between requests.
const MIN_INTERVAL_MS = Number(process.env.AO3_MIN_INTERVAL_MS ?? 5000);
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

// A Retry-After longer than this means come back later, not block the import.
const MAX_RETRY_AFTER_MS = 60_000;

// AO3 asks automated clients to be contactable. Kept in .env rather than the
// source so a clone doesn't publish an address.
const CONTACT = process.env.ARCHIVE_CONTACT?.trim();
const USER_AGENT =
  `an-archive-of-your-own/0.1 (personal archive tool${CONTACT ? `; +${CONTACT}` : ''})`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The _otwarchive_session cookie, from .env. Without it AO3 hides works whose
// authors restricted them to logged-in users. Read per call, not captured at
// import time, so tests can set and clear it.
function sessionCookie() {
  const raw = process.env.AO3_SESSION?.trim();
  if (!raw) return null;
  // Accept a bare value or a whole "name=value" paste.
  const prefix = '_otwarchive_session=';
  return (raw.startsWith(prefix) ? raw.slice(prefix.length) : raw) || null;
}

// Requests run one at a time, MIN_INTERVAL_MS apart, however many callers ask.
let queue = Promise.resolve();
let lastRequestAt = 0;

function serial(fn) {
  const result = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    return fn();
  });
  // Keep the queue alive: one failed fetch must not wedge every later one.
  queue = result.then(() => {}, () => {});
  return result;
}

// Retry-After is either a seconds count or an HTTP date.
function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// AO3 answers a restricted work with 200 and a redirect to the login form,
// so the final url is the only reliable signal.
function isLoginRedirect(url) {
  try {
    return new URL(url).pathname === '/users/login';
  } catch {
    return false;
  }
}

/**
 * Fetch one AO3 work or series page.
 *
 * @returns {Promise<{status: 'ok', html: string, url: string}
 *   | {status: 'restricted'|'expired_session'|'missing'}
 *   | {status: 'error', error: string}>}
 */
export function fetchAo3(url, { fetchImpl = fetch } = {}) {
  return serial(async () => {
    const target = `${url}?view_adult=true`;
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const cookie = sessionCookie();
      const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html' };
      if (cookie) headers.Cookie = `_otwarchive_session=${cookie}`;

      let res;
      try {
        lastRequestAt = Date.now();
        res = await fetchImpl(target, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Network failure or timeout: both worth another go.
        lastError = err?.message || String(err);
        lastRequestAt = Date.now();
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(MIN_INTERVAL_MS * attempt);
        continue;
      }
      lastRequestAt = Date.now();

      // AO3 fails transiently, including 525 from its CDN, so a 5xx is a
      // reason to retry rather than a verdict.
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        if (attempt === MAX_ATTEMPTS) break;
        const after = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
        if (after !== null && after > MAX_RETRY_AFTER_MS) {
          return { status: 'error', error: `rate limited for ${Math.round(after / 1000)}s` };
        }
        await sleep(after ?? MIN_INTERVAL_MS * attempt);
        continue;
      }

      if (isLoginRedirect(res.url)) {
        // Telling the user a work is restricted when really their cookie died
        // would send them hunting for the wrong problem.
        return { status: cookie ? 'expired_session' : 'restricted' };
      }

      if (res.status === 404) return { status: 'missing' };

      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };

      return { status: 'ok', html: await res.text(), url: res.url };
    }

    return { status: 'error', error: lastError };
  });
}
