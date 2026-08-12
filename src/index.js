/**
 * A minimal Cloudflare Worker that keeps a third-party API key off the device.
 *
 * The app calls this Worker; the Worker adds the secret key and forwards the
 * request upstream. The key lives in Worker secrets and is never shipped to a
 * client, so it cannot be extracted from an app binary.
 *
 * Secrets (set with `wrangler secret put NAME`):
 *   UPSTREAM_API_KEY  the key this Worker adds on the way out
 *   APP_TOKEN         shared token the app sends, so the endpoint is not open
 */

const UPSTREAM_URL = 'https://api.example.com/v1/messages';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // reject oversized payloads early

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Only POST is supported' }, 405);
    }

    // Gate the endpoint. This does not make the token secret — anyone who
    // inspects the app can find it — but it makes the endpoint *revocable*.
    // Rotate APP_TOKEN and every stale client is locked out at once, without
    // touching the upstream key. That is the real win: a blast radius you
    // control.
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (!env.UPSTREAM_API_KEY) {
      return json({ error: 'Server misconfigured: missing UPSTREAM_API_KEY' }, 500);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Request too large' }, 413);
    }

    // Forward the body untouched and add the secret. Nothing is logged or
    // stored: this Worker is a pass-through, so there is no copy of user
    // content anywhere in the middle.
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.UPSTREAM_API_KEY}`,
      },
      body,
    });

    // Stream the response straight back rather than buffering it, so large or
    // slow replies reach the app as they arrive.
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors())) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
