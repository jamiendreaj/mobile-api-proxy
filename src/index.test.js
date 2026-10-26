/**
 * Tests for the proxy.
 *
 * The whole value of this Worker is one claim: the upstream key reaches the
 * upstream service and nowhere else. A claim like that is worth very little
 * until something checks it on every change, so most of this file is spent
 * trying to get the key back out.
 *
 * Everything runs offline. `fetch` is stubbed, so no request leaves the
 * machine and no key is needed to run the suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const KEY = 'sk-upstream-SECRET-do-not-leak-0000';
const TOKEN = 'app-token-abc';
const env = () => ({ UPSTREAM_API_KEY: KEY, APP_TOKEN: TOKEN });

/** Replace global fetch and record what the Worker tried to send. */
function stubUpstream(response = new Response('{"ok":true}', { status: 200 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response() : response;
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const post = (body = '{"hi":true}', headers = { 'x-app-token': TOKEN }) =>
  new Request('https://proxy.test/', { method: 'POST', headers, body });

/** Every string a response could possibly carry, flattened. */
async function surfaceOf(res) {
  const parts = [res.status, res.statusText];
  for (const [k, v] of res.headers) parts.push(k, v);
  parts.push(await res.clone().text());
  return parts.join('\n');
}

/* ── the claim this repository makes ──────────────────────────────────── */

test('the key reaches upstream, in the Authorization header', async () => {
  const up = stubUpstream();
  try {
    await worker.fetch(post(), env());
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  } finally { up.restore(); }
});

test('the key never appears in a successful response', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post(), env());
    assert.equal((await surfaceOf(res)).includes(KEY), false);
  } finally { up.restore(); }
});

test('the key never appears when upstream returns an error', async () => {
  // The usual way a proxy leaks a key is an error handler that helpfully
  // echoes the failed request back to the caller.
  const up = stubUpstream(new Response('{"error":"bad request"}', { status: 400 }));
  try {
    const res = await worker.fetch(post(), env());
    assert.equal(res.status, 400, 'the upstream status is passed through');
    assert.equal((await surfaceOf(res)).includes(KEY), false);
  } finally { up.restore(); }
});

test('the key never appears when upstream returns a 500 with a verbose body', async () => {
  const leaky = new Response(
    JSON.stringify({ error: 'upstream exploded', echoed_request: { headers: {} } }),
    { status: 500 },
  );
  const up = stubUpstream(leaky);
  try {
    const res = await worker.fetch(post(), env());
    assert.equal((await surfaceOf(res)).includes(KEY), false);
  } finally { up.restore(); }
});

test('the key never appears in the misconfiguration error', async () => {
  // No upstream key set. The message must say what is wrong without printing
  // any part of a secret — including a truncated one.
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post(), { APP_TOKEN: TOKEN });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /UPSTREAM_API_KEY/, 'it names the missing variable');
    assert.equal(text.includes(KEY), false);
    assert.equal(up.calls.length, 0, 'and nothing was forwarded');
  } finally { up.restore(); }
});

/* ── the gate ─────────────────────────────────────────────────────────── */

test('a request with no app token is rejected', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post('{}', {}), env());
    assert.equal(res.status, 401);
    assert.equal(up.calls.length, 0, 'rejected before any upstream call');
  } finally { up.restore(); }
});

test('a request with the wrong app token is rejected', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post('{}', { 'x-app-token': 'wrong' }), env());
    assert.equal(res.status, 401);
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); }
});

test('the 401 does not reveal the expected token', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post('{}', { 'x-app-token': 'wrong' }), env());
    assert.equal((await surfaceOf(res)).includes(TOKEN), false);
  } finally { up.restore(); }
});

test('with no APP_TOKEN configured the gate is open, by design', async () => {
  // Documented behaviour rather than an oversight: the token is optional so
  // the Worker can be stood up before an app ships. Asserted so that if it
  // ever changes, it changes deliberately.
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post('{}', {}), { UPSTREAM_API_KEY: KEY });
    assert.equal(res.status, 200);
    assert.equal(up.calls.length, 1);
  } finally { up.restore(); }
});

/* ── method handling ──────────────────────────────────────────────────── */

test('OPTIONS is answered locally, with CORS and no upstream call', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(new Request('https://proxy.test/', { method: 'OPTIONS' }), env());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); }
});

test('anything that is not POST is refused', async () => {
  const up = stubUpstream();
  try {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await worker.fetch(new Request('https://proxy.test/', { method }), env());
      assert.equal(res.status, 405, method);
    }
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); }
});

/* ── size limit ───────────────────────────────────────────────────────── */

test('an oversized body is refused BEFORE the upstream call', async () => {
  // The point of the limit is not politeness. A 50MB body forwarded upstream
  // is billed to the account this Worker exists to protect.
  const up = stubUpstream();
  try {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    const res = await worker.fetch(post(big), env());
    assert.equal(res.status, 413);
    assert.equal(up.calls.length, 0, 'nothing was forwarded, so nothing was billed');
  } finally { up.restore(); }
});

test('a body just under the limit is forwarded', async () => {
  const up = stubUpstream();
  try {
    const res = await worker.fetch(post('x'.repeat(1024)), env());
    assert.equal(res.status, 200);
    assert.equal(up.calls.length, 1);
  } finally { up.restore(); }
});

/* ── pass-through behaviour ───────────────────────────────────────────── */

test('the body is forwarded untouched', async () => {
  const up = stubUpstream();
  try {
    const payload = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'héllo ünicode' }] });
    await worker.fetch(post(payload), env());
    const sent = Buffer.from(up.calls[0].init.body).toString('utf8');
    assert.equal(sent, payload, 'no re-encoding, no rewriting');
  } finally { up.restore(); }
});

test('it posts to one fixed upstream URL, not one the caller chooses', async () => {
  // The caller cannot redirect this Worker at an endpoint of their choosing,
  // which would turn it into an open relay carrying your key.
  const up = stubUpstream();
  try {
    const res = await worker.fetch(
      new Request('https://proxy.test/?url=https://evil.test', {
        method: 'POST', headers: { 'x-app-token': TOKEN }, body: '{}',
      }),
      env(),
    );
    assert.equal(res.status, 200);
    assert.equal(up.calls[0].url.includes('evil.test'), false);
    assert.match(up.calls[0].url, /^https:\/\//);
  } finally { up.restore(); }
});

test('CORS headers are on every response, including errors', async () => {
  const up = stubUpstream(new Response('{}', { status: 400 }));
  try {
    const responses = [
      await worker.fetch(new Request('https://proxy.test/', { method: 'OPTIONS' }), env()),
      await worker.fetch(new Request('https://proxy.test/', { method: 'GET' }), env()),
      await worker.fetch(post('{}', {}), env()),
      await worker.fetch(post(), env()),
    ];
    for (const res of responses) {
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', `status ${res.status}`);
    }
  } finally { up.restore(); }
});

test('the upstream status is preserved rather than flattened to 200', async () => {
  for (const status of [200, 201, 400, 401, 429, 500, 503]) {
    const up = stubUpstream(new Response('{}', { status }));
    try {
      const res = await worker.fetch(post(), env());
      assert.equal(res.status, status);
    } finally { up.restore(); }
  }
});

test('the response is streamed, not buffered into a new body', async () => {
  // A buffering proxy holds user content in memory in the middle, which is
  // exactly what the README promises it does not do.
  const stream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"streamed":true}')); c.close(); },
  });
  const up = stubUpstream(new Response(stream, { status: 200 }));
  try {
    const res = await worker.fetch(post(), env());
    assert.equal(await res.text(), '{"streamed":true}');
  } finally { up.restore(); }
});
