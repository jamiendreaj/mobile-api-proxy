# Keeping API keys out of mobile apps

A small Cloudflare Worker that holds a third-party API key server-side, so the
app never carries it.

I built this pattern for [Tutto AI](https://apps.apple.com/us/app/tutto-ai/id6776184829),
an iOS app that calls an AI provider on every message. This repository is the
pattern on its own, stripped of anything app-specific, so it can be read in a
few minutes or reused.

## The problem

A mobile app that calls a paid API needs a key. The obvious place to put it is
in the source:

```js
const API_KEY = 'sk-live-abc123...';   // don't
```

This looks private. It isn't.

An `.ipa` or `.apk` is an archive. Anyone can download the app, unzip it, and
read the strings inside the JavaScript bundle. Environment variables don't help
either — bundlers inline them at build time, so `process.env.API_KEY` becomes
the literal key in the shipped file.

There is no way to hide a secret inside something you hand to the user. The only
question is how long it takes someone to find it.

The cost is not theoretical: an extracted key is charged to your account until
you notice.

## The fix

Put the key somewhere the user never receives, and give the app a way to ask
that server to make the call on its behalf.

```
Before   app ──(key inside the app)──▶ API          key is extractable
After    app ──────────────────────▶ Worker ──(key)──▶ API   key never leaves the server
```

The app now sends its request to a Worker you control. The Worker adds the key
and forwards it upstream. The key lives in Worker secrets — it is never part of
any download.

## What this Worker does

- **Adds the upstream key** to every forwarded request
- **Requires a shared token** (`x-app-token`) so the endpoint is not open to the world
- **Rejects oversized payloads** before doing any work
- **Streams the response back** instead of buffering it
- **Logs and stores nothing** — it is a pass-through, so no copy of user content
  exists in the middle

Around 70 lines, in [`src/index.js`](src/index.js).

## About that shared token

The token is in the app, so it is extractable too. That is not a flaw, because
it is doing a different job.

The upstream key is the valuable secret: it bills to your account and often
cannot be scoped. The app token is **cheap to rotate**. If it leaks, change one
Worker secret and ship an app update — every stale client is locked out, and the
upstream key was never exposed at any point.

The point is not to make the endpoint unbreakable. It is to convert an
unrevocable problem into a revocable one.

For a production app you would add rate limiting on top, so a leaked token
cannot be used to run up a bill before you notice.

## Running it

```bash
npm install -g wrangler
wrangler login

wrangler secret put UPSTREAM_API_KEY
wrangler secret put APP_TOKEN

wrangler deploy
```

For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and
run `wrangler dev`.

Then point the app at the deployed URL:

```js
await fetch('https://your-worker.workers.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-app-token': APP_TOKEN,
  },
  body: JSON.stringify(payload),
});
```

Set `UPSTREAM_URL` in `src/index.js` to whichever API you are calling, and adjust
the auth header to match what that provider expects — some want
`Authorization: Bearer`, others a custom header such as `x-api-key`.

## Tests

```bash
npm test
```

18 tests, all offline. `fetch` is stubbed, so nothing leaves the machine and no
key is needed to run them.

This Worker makes one claim — the upstream key reaches the upstream service and
nowhere else — and a claim like that is worth very little until something checks
it on every change. So six of the tests exist purely to try to get the key back
out: on success, on a 400, on a 500 with a verbose body, in the misconfiguration
error, in the 401, and through a caller trying to point the Worker at an
endpoint of their own.

The rest cover the things that are easy to get wrong later:

- an oversized body is refused **before** the upstream call, so a 50MB payload
  is never billed to the account this exists to protect
- the 401 does not reveal the token it was expecting
- the upstream status is passed through rather than flattened to 200
- the response is streamed, not buffered into a new body — the README promises
  no copy of user content sits in the middle, and that is now asserted
- the body is forwarded byte for byte, with no re-encoding

## Why Cloudflare Workers

Free tier of 100,000 requests a day, deploys in seconds, and runs close to the
user, so the extra hop adds little latency. Any small server would do — this
happens to be the cheapest way to run one that does almost nothing.

---

Jamie Ndreaj · [jamiendreaj.github.io](https://jamiendreaj.github.io)
