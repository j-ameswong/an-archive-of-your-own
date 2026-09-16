// Turning a pasted AO3 link into a database key.
//
// `fic.slug` is the unique key, so every link that names the same work has to
// collapse to the same string: chapter deep links, ?view_adult=true, the
// collection-scoped path AO3 uses when a work is in a collection, #workskin.

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

// An optional /collections/<name> prefix, then works|series and the id.
// Anything after the id -- /chapters/456, /navigate, /comments -- is a view of
// the same record and is dropped.
const AO3_PATH = /^(?:\/collections\/[^/]+)?\/(works|series)\/(\d+)(?:\/.*)?$/;

/**
 * @returns {{kind: 'work'|'series', slug: string, url: string} | null}
 *   null for anything that is not an AO3 work or series link.
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

  const [, collection, id] = match;
  const slug = `${collection}/${id}`;

  return {
    kind: collection === 'works' ? 'work' : 'series',
    slug,
    url: `https://archiveofourown.org/${slug}`,
  };
}
