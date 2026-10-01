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

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

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

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Invite Board data model
//
// invite_links: one row per invite link a user creates. `expires_at` and
// `max_uses` are NULL for "never expires" / "unlimited".
// invite_joins: one row per person who joined through a link. UNIQUE on
// invitee_user_id means a person is counted for the FIRST invite that
// brought them here, and never twice.
//
// Both tables stay public: they only carry usernames and counts, which the
// leaderboard shows to everyone by design.
// ---------------------------------------------------------------------------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_links (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      creator_user_id INTEGER NOT NULL,
      creator_username TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      max_uses INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_joins (
      id BIGSERIAL PRIMARY KEY,
      link_id BIGINT NOT NULL REFERENCES invite_links(id) ON DELETE CASCADE,
      invitee_user_id INTEGER NOT NULL UNIQUE,
      invitee_username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// Staging previews start from an empty copy of production. Seed a handful of
// obviously-fake links and joins (fake identities only, never the visitor)
// so the leaderboard is reviewable in every PR preview. Idempotent: staging
// containers rebuild on every push. Production never runs this.
async function seedStaging() {
  const { rows } = await pool.query(`
    INSERT INTO invite_links (code, creator_user_id, creator_username, created_at)
    VALUES
      ('stagingdemo1', 900101, 'staging-demo-alice', NOW() - INTERVAL '5 days'),
      ('stagingdemo2', 900101, 'staging-demo-alice', NOW() - INTERVAL '3 days'),
      ('stagingdemo3', 900102, 'staging-demo-bob',   NOW() - INTERVAL '2 days'),
      ('stagingdemo4', 900103, 'staging-demo-maya',  NOW() - INTERVAL '1 day')
    ON CONFLICT (code) DO NOTHING
    RETURNING id, code
  `);
  const byCode = Object.fromEntries(rows.map(r => [r.code, r.id]));
  const joins = [
    ['stagingdemo1', 900201, 'staging-demo-ben'],
    ['stagingdemo1', 900202, 'staging-demo-cat'],
    ['stagingdemo1', 900203, 'staging-demo-dev'],
    ['stagingdemo2', 900204, 'staging-demo-eli'],
    ['stagingdemo3', 900205, 'staging-demo-fay'],
  ];
  for (const [code, userId, username] of joins) {
    if (!byCode[code]) continue;
    await pool.query(`
      INSERT INTO invite_joins (link_id, invitee_user_id, invitee_username)
      VALUES ($1, $2, $3)
      ON CONFLICT (invitee_user_id) DO NOTHING
    `, [byCode[code], userId, username]);
  }
}

function health(_req, res) {
  // Once shutdown started, report the container as leaving rotation rather
  // than healthy, so anything polling readiness stops routing to it.
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
}

app.get('/health', health);

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------

// Unambiguous lowercase charset: no 0/O, 1/l/I.
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode() {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

// A link is usable while it hasn't expired and hasn't hit its use cap.
function isActive(link, joinCount) {
  if (link.expires_at && new Date(link.expires_at) <= new Date()) return false;
  if (link.max_uses != null && joinCount >= link.max_uses) return false;
  return true;
}

// Every link with its join count and, for the "who invited who" view, the
// names it brought in (first join first). Leaderboard and My invites both
// build on this.
async function loadLinks(where, params) {
  const { rows } = await pool.query(`
    SELECT l.id, l.code, l.creator_user_id, l.creator_username,
           l.expires_at, l.max_uses, l.created_at,
           COUNT(j.id)::int AS joins,
           COALESCE(
             ARRAY_AGG(j.invitee_username ORDER BY j.created_at)
             FILTER (WHERE j.id IS NOT NULL), '{}'
           ) AS invitees
    FROM invite_links l
    LEFT JOIN invite_joins j ON j.link_id = l.id
    ${where}
    GROUP BY l.id
    ORDER BY l.created_at DESC
    LIMIT 200
  `, params);
  return rows;
}

function shapeLink(row) {
  return {
    code: row.code,
    creator: row.creator_username,
    mine: undefined, // set by callers that know the viewer
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    joins: Number(row.joins),
    invitees: row.invitees || [],
    active: isActive(row, Number(row.joins)),
  };
}

// Leaderboard: every creator ranked by total joins across their links, with
// each link's own count underneath.
app.get('/api/leaderboard', async (req, res) => {
  try {
    const rows = await loadLinks('', []);
    const byCreator = new Map();
    for (const row of rows) {
      const link = shapeLink(row);
      link.mine = req.user ? row.creator_user_id === req.user.id : false;
      if (!byCreator.has(row.creator_username)) {
        byCreator.set(row.creator_username, {
          username: row.creator_username,
          userId: row.creator_user_id,
          total: 0,
          links: [],
        });
      }
      const inviter = byCreator.get(row.creator_username);
      inviter.total += link.joins;
      inviter.links.push(link);
    }
    const inviters = [...byCreator.values()]
      .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username))
      .slice(0, 50);
    res.json({ inviters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// My invites: the signed-in user's links with uses left.
app.get('/api/links', async (req, res) => {
  try {
    const rows = await loadLinks('WHERE l.creator_user_id = $1', [req.user.id]);
    res.json({
      me: { id: req.user.id, username: req.user.username },
      links: rows.map(r => ({ ...shapeLink(r), mine: true })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create link. Both limits are optional: empty means "never expires" /
// "unlimited uses".
app.post('/api/links', async (req, res) => {
  try {
    const body = req.body || {};
    const days = body.days;
    const maxUses = body.maxUses;

    let expiresAt = null;
    if (days != null && days !== '') {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return res.status(400).json({ error: 'Days must be between 1 and 365' });
      }
      expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
    }
    if (maxUses != null && maxUses !== '') {
      const n = Number(maxUses);
      if (!Number.isInteger(n) || n < 1 || n > 9999) {
        return res.status(400).json({ error: 'Max uses must be between 1 and 9999' });
      }
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        const { rows } = await pool.query(`
          INSERT INTO invite_links (code, creator_user_id, creator_username, expires_at, max_uses)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [code, req.user.id, req.user.username, expiresAt, maxUses == null || maxUses === '' ? null : Number(maxUses)]);
        const row = rows[0];
        return res.json({
          link: {
            ...shapeLink({ ...row, joins: 0, invitees: [] }),
            mine: true,
          },
        });
      } catch (err) {
        // Unique violation on code: collision, draw another one. Anything
        // else is a real error.
        if (err.code !== '23505') throw err;
      }
    }
    return res.status(500).json({ error: 'Could not allocate a link code' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join: called by the frontend when the app is opened with ?invite=CODE.
// A person joins once, ever: their first invite wins. Self-invites, expired
// links and used-up links are refused with a reason the UI can show.
app.post('/api/join', async (req, res) => {
  try {
    const code = (req.body || {}).code;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'Missing invite code' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM invite_links WHERE code = $1', [code.trim().toLowerCase()]);
    const link = rows[0];
    if (!link) return res.json({ joined: false, reason: 'unknown' });
    if (link.creator_user_id === req.user.id) {
      return res.json({ joined: false, reason: 'self' });
    }
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM invite_joins WHERE invitee_user_id = $1', [req.user.id]);
    if (existing.length) return res.json({ joined: false, reason: 'already' });
    const { rows: counted } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM invite_joins WHERE link_id = $1', [link.id]);
    if (!isActive(link, counted[0].n)) {
      return res.json({ joined: false, reason: 'inactive' });
    }
    const inserted = await pool.query(`
      INSERT INTO invite_joins (link_id, invitee_user_id, invitee_username)
      VALUES ($1, $2, $3)
      ON CONFLICT (invitee_user_id) DO NOTHING
      RETURNING id
    `, [link.id, req.user.id, req.user.username]);
    if (!inserted.rows.length) return res.json({ joined: false, reason: 'already' });
    res.json({ joined: true, inviter: link.creator_username });
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
  if (!req.user) {
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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/invite-board-ad93b6/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/invite-board-ad93b6/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const DRAIN_MS = 3000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent: SIGTERM then SIGINT must not double-run
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(() => {});
  server.closeIdleConnections?.();
  const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

async function start() {
  await migrate();
  if (IS_STAGING) {
    try {
      await seedStaging();
    } catch (err) {
      // A failed seed must never stop the app from booting.
      console.warn('staging seed failed: ' + err.message);
    }
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

let server;

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });