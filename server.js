const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT. /api/rotation is
// here because visitors may look at everything, and the rotation carries
// only usernames, which are public on Homeroom; the write routes stay
// account-only.
const PUBLIC_API_PATHS = new Set(['/health', '/api/rotation']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

// Staging vs production. Only staging gets seed data.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The rotation turns over every Monday, counted from this fixed Monday so
// the turn depends on the calendar, not on when rows were added.
const ROTATION_ANCHOR = Date.UTC(2026, 0, 5); // Monday 5 Jan 2026
const DAY_MS = 86_400_000;

// Whose turn it is, and who the viewer is. Guests may read, so nothing
// here assumes req.user. All three routes answer with this same shape.
async function rotationFor(user) {
  const { rows } = await pool.query(`
    SELECT user_id, username FROM household_members ORDER BY id
  `);
  const { rows: dayRows } = await pool.query(`
    SELECT weekday FROM bin_day_setting ORDER BY id DESC LIMIT 1
  `);
  const members = rows.map(r => r.username);
  const turnIndex = members.length
    ? ((Math.floor((Date.now() - ROTATION_ANCHOR) / DAY_MS / 7) % members.length)
       + members.length) % members.length
    : null;
  return {
    members,
    turnIndex,
    turnUsername: turnIndex === null ? null : members[turnIndex],
    binDay: dayRows.length ? dayRows[0].weekday : null,
    viewerUsername: user ? user.username : null,
    viewerIsMember: user ? rows.some(r => r.user_id === user.id) : false,
  };
}

// Rotation and bin day (public to signed-in users and guests alike).
app.get('/api/rotation', async (_req, res) => {
  try {
    res.json(await rotationFor(_req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join the rotation, at the end of the turn order. Idempotent: joining
// twice changes nothing.
app.post('/api/join', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO household_members (user_id, username)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO NOTHING
    `, [req.user.id, req.user.username]);
    res.json(await rotationFor(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set (or change) bin day: one weekly weekday for the whole flat, 0 = Sunday
// to match the browser's getDay(). Append-only, so the history is kept.
app.post('/api/bin-day', async (req, res) => {
  const weekday = req.body && req.body.weekday;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return res.status(400).json({ error: 'weekday must be an integer from 0 (Sunday) to 6 (Saturday)' });
  }
  try {
    await pool.query(`
      INSERT INTO bin_day_setting (weekday, set_by_user_id, set_by_username)
      VALUES ($1, $2, $3)
    `, [weekday, req.user.id, req.user.username]);
    res.json(await rotationFor(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/flat-4b-chores-e98ecd/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/flat-4b-chores-e98ecd/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_members (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bin_day_setting (
      id SERIAL PRIMARY KEY,
      weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      set_by_user_id INTEGER,
      set_by_username VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Staging only: obviously fake members and a bin day so the populated
  // screen can be seen. Idempotent, fake identities only — the visitor is
  // never seeded, so "has the viewer joined" stays testable by hand.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO household_members (user_id, username) VALUES
        (900001, 'Staging demo Maya'),
        (900002, 'Staging demo Jasper'),
        (900003, 'Staging demo Sophie')
      ON CONFLICT (user_id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO bin_day_setting (weekday, set_by_username)
      SELECT 4, 'Staging demo Maya'
      WHERE NOT EXISTS (SELECT 1 FROM bin_day_setting)
    `);
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
