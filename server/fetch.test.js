import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAo3 } from './import.js';

const WORK = 'https://archiveofourown.org/works/6623293';
const LOGIN = 'https://archiveofourown.org/users/login?restricted=true';

// A stub standing in for fetch: hands back a scripted response per call and
// records what it was asked for.
function stub(...responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = '', url: finalUrl = url, headers = {} } = next;
    return {
      status,
      ok: status >= 200 && status < 300,
      url: finalUrl,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  return { impl, calls };
}

test('a 200 returns the page body and final url', async () => {
  const { impl, calls } = stub({ body: '<html>work</html>' });
  assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), {
    status: 'ok',
    html: '<html>work</html>',
    url: `${WORK}?view_adult=true`,
  });
  assert.equal(calls[0].url, `${WORK}?view_adult=true`);
});

test('sends a contactable user-agent', async () => {
  const { impl, calls } = stub({ body: '' });
  await fetchAo3(WORK, { fetchImpl: impl });
  assert.match(calls[0].options.headers['User-Agent'], /an-archive-of-your-own/);
});

test('a 404 is a missing work, not an error', async () => {
  const { impl } = stub({ status: 404 });
  assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), { status: 'missing' });
});

// The cookie is read from the environment per call, so each test states
// outright whether one is configured instead of inheriting the developer's.
function withSession(value, fn) {
  const had = Object.hasOwn(process.env, 'AO3_SESSION');
  const previous = process.env.AO3_SESSION;
  if (value === null) delete process.env.AO3_SESSION;
  else process.env.AO3_SESSION = value;
  return (async () => fn())().finally(() => {
    if (had) process.env.AO3_SESSION = previous;
    else delete process.env.AO3_SESSION;
  });
}

test('a login redirect without a cookie means the work is restricted', async () => {
  const { impl } = stub({ url: LOGIN });
  await withSession(null, async () => {
    assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), { status: 'restricted' });
  });
});

test('a login redirect with a cookie means the cookie died', async () => {
  const { impl } = stub({ url: LOGIN });
  await withSession('a-session-value', async () => {
    assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), { status: 'expired_session' });
  });
});

test('sends the cookie when one is configured, and none when not', async () => {
  const { impl: withIt, calls: a } = stub({ body: '' });
  await withSession('a-session-value', () => fetchAo3(WORK, { fetchImpl: withIt }));
  assert.equal(a[0].options.headers.Cookie, '_otwarchive_session=a-session-value');

  const { impl: without, calls: b } = stub({ body: '' });
  await withSession(null, () => fetchAo3(WORK, { fetchImpl: without }));
  assert.equal(b[0].options.headers.Cookie, undefined);
});

test('accepts a whole name=value cookie paste, not just the bare value', async () => {
  const { impl, calls } = stub({ body: '' });
  await withSession('_otwarchive_session=pasted', () => fetchAo3(WORK, { fetchImpl: impl }));
  assert.equal(calls[0].options.headers.Cookie, '_otwarchive_session=pasted');
});

test('retries a 429 and honours Retry-After', async () => {
  const { impl, calls } = stub(
    { status: 429, headers: { 'retry-after': '0' } },
    { body: 'ok' },
  );
  const res = await fetchAo3(WORK, { fetchImpl: impl });
  assert.equal(res.status, 'ok');
  assert.equal(calls.length, 2);
});

test('retries a 5xx, as AO3 served us a transient 525', async () => {
  const { impl, calls } = stub({ status: 525 }, { status: 503 }, { body: 'ok' });
  const res = await fetchAo3(WORK, { fetchImpl: impl });
  assert.equal(res.status, 'ok');
  assert.equal(calls.length, 3);
});

test('gives up after the attempt limit and reports the last failure', async () => {
  const { impl, calls } = stub({ status: 500 }, { status: 500 }, { status: 500 });
  assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), {
    status: 'error',
    error: 'HTTP 500',
  });
  assert.equal(calls.length, 3);
});

test('refuses to block on an absurd Retry-After', async () => {
  const { impl, calls } = stub({ status: 429, headers: { 'retry-after': '3600' } });
  const res = await fetchAo3(WORK, { fetchImpl: impl });
  assert.equal(res.status, 'error');
  assert.match(res.error, /rate limited for 3600s/);
  assert.equal(calls.length, 1);
});

test('retries a network failure', async () => {
  const { impl, calls } = stub(new TypeError('fetch failed'), { body: 'ok' });
  const res = await fetchAo3(WORK, { fetchImpl: impl });
  assert.equal(res.status, 'ok');
  assert.equal(calls.length, 2);
});

test('a network failure that never clears is an error', async () => {
  const boom = () => new TypeError('fetch failed');
  const { impl } = stub(boom(), boom(), boom());
  assert.deepEqual(await fetchAo3(WORK, { fetchImpl: impl }), {
    status: 'error',
    error: 'fetch failed',
  });
});

test('one failed fetch does not wedge the queue', async () => {
  const { impl: failing } = stub(new TypeError('x'), new TypeError('x'), new TypeError('x'));
  await fetchAo3(WORK, { fetchImpl: failing });
  const { impl: working } = stub({ body: 'later' });
  const res = await fetchAo3(WORK, { fetchImpl: working });
  assert.equal(res.status, 'ok');
});

test('requests are serialised, never concurrent', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const impl = async () => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { status: 200, ok: true, url: WORK, headers: { get: () => null }, text: async () => '' };
  };
  await Promise.all([
    fetchAo3(WORK, { fetchImpl: impl }),
    fetchAo3(WORK, { fetchImpl: impl }),
    fetchAo3(WORK, { fetchImpl: impl }),
  ]);
  assert.equal(maxInFlight, 1);
});
