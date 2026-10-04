const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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

// ── The rota ──────────────────────────────────────────────────────────────
// The screen's one job: see whose turn it is for each chore this week and
// mark chores done.

// The week runs Monday to Monday in UTC, so the whole flat's rota turns
// over at the same moment wherever a flatmate lives. `week_start` is the
// Monday's date as 'YYYY-MM-DD' — a plain string, so a database session in
// any timezone stores the same day.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function currentWeekStart() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay(): 0 = Sunday … 6 = Saturday. Shift to Monday-first.
  const daysSinceMonday = (new Date(today).getUTCDay() + 6) % 7;
  return new Date(today - daysSinceMonday * 24 * 60 * 60 * 1000);
}

function currentWeekIso() {
  return currentWeekStart().toISOString().slice(0, 10);
}

// The rotation index: complete weeks since Monday 1970-01-05 (week 0), so
// the count keeps ticking whatever the database's clock timezone is.
function weekNumber(weekIso) {
  return Math.floor(Date.parse(weekIso + 'T00:00:00Z') / WEEK_MS);
}

// First open joins the rota: a member row per person, in the order they
// first opened the app. Guests are never upserted — a write without an
// account never gets here in the first place. Returns the member row, so
// callers can reference the rota's own member id (the turns table keys
// done_by_id to members.id, not the platform account id).
async function upsertMember(user) {
  const { rows } = await pool.query(
    `INSERT INTO members (user_id, username) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING id, username`,
    [user.id, user.username]
  );
  if (rows.length) return rows[0];
  // Another request inserted the row between us and the conflict: read it.
  const { rows: existing } = await pool.query(
    'SELECT id, username FROM members WHERE user_id = $1',
    [user.id]
  );
  return existing[0];
}

// Materialize this week's turn rows once per week. The holder of the chore
// with rotation offset `o` in week `w` is members[(w + o) % count]; the
// member list is as of the first read of the week, so someone joining
// mid-week cannot shift this week's turns — they enter the cycle next
// Monday. ON CONFLICT DO NOTHING keeps concurrent first reads safe: both
// then see the same row.
async function ensureWeekTurns(weekIso) {
  const { rows: members } = await pool.query(
    'SELECT id FROM members ORDER BY joined_at, id'
  );
  if (!members.length) return;
  const { rows: chores } = await pool.query(
    'SELECT id, rotation_offset FROM chores ORDER BY position'
  );
  const week = weekNumber(weekIso);
  for (const chore of chores) {
    const holder = members[(week + chore.rotation_offset) % members.length];
    await pool.query(
      `INSERT INTO turns (chore_id, week_start, member_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (chore_id, week_start) DO NOTHING`,
      [chore.id, weekIso, holder.id]
    );
  }
}

// The state the screen renders from. `next` is the signature element: each
// chore shows not only who has it now but who takes it next, so the weekly
// cycle is visible without navigation. With a single member there is no
// next person and `next` is null.
async function buildState(weekIso) {
  const { rows: members } = await pool.query(
    'SELECT id, username FROM members ORDER BY joined_at, id'
  );
  const { rows: chores } = await pool.query(
    `SELECT c.id, c.name, c.due_day, t.member_id,
            tu.username AS turn_username, t.done_by_id
     FROM chores c
     LEFT JOIN turns t ON t.chore_id = c.id AND t.week_start = $1
     LEFT JOIN members tu ON tu.id = t.member_id
     ORDER BY c.position`,
    [weekIso]
  );
  return chores.map((c) => {
    const idx = members.findIndex((m) => m.id === c.member_id);
    const next = members.length > 1 && idx !== -1
      ? members[(idx + 1) % members.length]
      : null;
    return {
      id: c.id,
      name: c.name,
      dueDay: c.due_day,
      turn: c.turn_username ? { username: c.turn_username } : null,
      next: next ? { username: next.username } : null,
      done: c.done_by_id !== null,
    };
  });
}

// A guest may read the rota (the middleware lets every GET through) but is
// never added to `members` — the names on it are people with accounts.
app.get('/api/state', async (req, res) => {
  try {
    if (req.user) await upsertMember(req.user);
    const weekIso = currentWeekIso();
    await ensureWeekTurns(weekIso);
    res.json({ weekStart: weekIso, chores: await buildState(weekIso) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tick a chore off for this week — or undo the tick. The week is computed
// HERE, never trusted from the client, so a stale client cannot tick an
// old week. The tick lives on the turn row (done_by_*), so it belongs to a
// chore-and-week, survives reloads and keeps last week's history intact.
app.post('/api/chores/:id/done', async (req, res) => {
  try {
    const choreId = parseInt(req.params.id, 10);
    if (!Number.isInteger(choreId)) {
      return res.status(404).json({ error: 'not_found' });
    }
    const member = await upsertMember(req.user);
    const weekIso = currentWeekIso();
    await ensureWeekTurns(weekIso);
    const { rowCount } = await pool.query(
      `UPDATE turns SET
         done_by_id = CASE WHEN done_by_id IS NULL THEN $3::int ELSE NULL END,
         done_by_username = CASE WHEN done_by_username IS NULL THEN $4::varchar ELSE NULL END,
         done_at = CASE WHEN done_at IS NULL THEN NOW() ELSE NULL END
       WHERE chore_id = $1 AND week_start = $2`,
      [choreId, weekIso, member.id, member.username]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ weekStart: weekIso, chores: await buildState(weekIso) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

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

// ── Boot: migration and staging seed ─────────────────────────────────────
async function migrate() {
  // All three tables are public on purpose (the platform default): member
  // rows hold only platform ids and public usernames, and chores and turns
  // are rota content every flatmate already sees in the UI.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chores (
      id SERIAL PRIMARY KEY,
      name VARCHAR(64) NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      rotation_offset INTEGER NOT NULL,
      due_day VARCHAR(16) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS turns (
      id SERIAL PRIMARY KEY,
      chore_id INTEGER NOT NULL REFERENCES chores(id),
      week_start DATE NOT NULL,
      member_id INTEGER NOT NULL REFERENCES members(id),
      done_by_id INTEGER REFERENCES members(id),
      done_by_username VARCHAR(255),
      done_at TIMESTAMPTZ,
      UNIQUE (chore_id, week_start)
    )
  `);
  // The starter's demo table goes with the starter screen.
  await pool.query('DROP TABLE IF EXISTS presses');
}

async function seed() {
  // The screen cannot render without the three chores; seed them in BOTH
  // environments whenever the table is empty (a boot-time migration, never
  // a per-request path).
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM chores');
  if (rows[0].n === 0) {
    await pool.query(`
      INSERT INTO chores (name, position, rotation_offset, due_day) VALUES
        ('bins', 0, 0, 'Friday'),
        ('dishes', 1, 1, 'Thursday'),
        ('hoovering', 2, 2, 'Saturday')
      ON CONFLICT (name) DO NOTHING
    `);
  }
  // Staging previews start from an empty copy of production, so a fresh
  // one shows nobody in the rota. Seed three obviously fake members so the
  // screen shows a populated rotation. Rows are never attributed to a real
  // viewer: a real person opening a staging preview is appended after the
  // demos by the normal first-open path above.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO members (user_id, username, joined_at) VALUES
        (900001, 'Staging demo Maya',   NOW() - INTERVAL '9 days'),
        (900002, 'Staging demo Jasper', NOW() - INTERVAL '8 days'),
        (900003, 'Staging demo Sophie', NOW() - INTERVAL '7 days')
      ON CONFLICT (user_id) DO NOTHING
    `);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// The platform stops this app with SIGTERM: stop accepting connections,
// drain in-flight ones, close the pool, exit. The drain is a literal
// constant (not an env var) so a deployment can't talk itself out of it.
const DRAIN_MS = 3000;
let server = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown || !server) return;
  shuttingDown = true;
  console.log(`${signal} received: closing the server, draining ${DRAIN_MS} ms`);
  // /health answers 503 from now on, so a load balancer stops sending
  // traffic while the drain runs.
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  const force = setTimeout(() => {
    pool.end().finally(() => process.exit(0));
  }, DRAIN_MS);
  force.unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  await seed();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
