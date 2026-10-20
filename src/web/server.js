'use strict';
/**
 * The web journal: a landing page at /, the journal and control panel at /app, and a JSON API under
 * /api. Plain node:http, no framework, started by the ready listener once the bot is online.
 *
 * Environment (see .env.example): SERVER_PORT (or PORT) and PUBLIC_BASE_URL from the host,
 * DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / SESSION_SECRET for Discord login, and
 * PANEL_FRAME_ANCESTORS to allow embedding (Whop). WEB_ENABLED=0 turns the site off.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');

const PUBLIC = path.join(__dirname, 'public');
const FONTS = path.join(__dirname, '..', '..', 'assets', 'fonts');
const SAMPLES = path.join(__dirname, '..', '..', 'assets', 'reference');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' };
const JSON_LIMIT = 14 * 1024 * 1024;   // a CSV (2 MB) or a chart picture (8 MB as base64)

/* ---------------- plumbing ---------------- */
function headers(extra = {}) {
  const fa = auth.config().frameAncestors;
  return {
    'content-security-policy': [
      "default-src 'self'", "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net", "style-src 'self' 'unsafe-inline'", "script-src 'self'",
      "font-src 'self'", "connect-src 'self'", "form-action 'self' https://discord.com", "base-uri 'none'", `frame-ancestors ${fa.length ? fa.join(' ') : "'none'"}`,
    ].join('; '),
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    ...(fa.length ? {} : { 'x-frame-options': 'DENY' }), ...extra,
  };
}
function send(res, status, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, headers({ 'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'content-length': buf.length, ...extra }));
  res.end(buf);
}
const json = (res, status, obj, extra) => send(res, status, Buffer.from(JSON.stringify(obj)), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
const fail = (res, status, error, detail) => json(res, status, { error, detail });
function readBody(req, limit = JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { if (!parts.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(Object.assign(new Error('bad_json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
// pages link their css and js with ?v=<this start>, so a deploy is never hidden behind a browser cache
const VERSION = Date.now().toString(36);
function file(res, p, { cache = 'public, max-age=86400' } = {}) {
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    // link previews (Discord, X, iMessage) need the banner's full address: the site's own, from PUBLIC_BASE_URL
    if (p.endsWith('.html')) buf = Buffer.from(buf.toString('utf8').replace(/__V__/g, VERSION).replace(/__ORIGIN__/g, (auth.config().baseUrl || '').replace(/\/+$/, '')));
    send(res, 200, buf, { 'content-type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'cache-control': cache });
  });
}
/** a request path mapped inside a folder, or null if it tries to climb out */
function inside(root, rel) {
  const p = path.normalize(path.join(root, decodeURIComponent(rel)));
  return p.startsWith(root + path.sep) ? p : null;
}

// a gentle per-IP limit for logins and writes
const hits = new Map();
function limited(req, bucket, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = `${bucket}:${ip}`, now = Date.now(), w = (hits.get(k) || []).filter((t) => now - t < 60000);
  w.push(now); hits.set(k, w);
  if (hits.size > 5000) hits.clear();
  return w.length > max;
}

/* ---------------- pages ---------------- */
function popupPage(token, handoff) {
  // the popup hands the session to the embed that opened it, then closes; the token never lands in a URL
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title><link rel="stylesheet" href="/css/base.css"></head>
<body class="popup"><div class="popup-card"><span class="dot live"></span> Signed in. You can close this window.</div>
<div id="jb-handoff" data-token="${token.replace(/[^\w.-]/g, '')}" data-h="${String(handoff || '').replace(/[^\w-]/g, '')}" hidden></div><script src="/js/popup.js"></script></body></html>`;
}
function errorPage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/css/base.css"></head>
<body class="popup"><div class="popup-card"><b>${title}</b><p>${text}</p><a class="btn white" href="/">Back home</a></div></body></html>`;
}

/* ---------------- the server ---------------- */
function createServer(client) {
  const api = require('./routes')(client, { json, fail, readBody, limited });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    try {
      if (p === '/healthz') return json(res, 200, { ok: true, bot: client.isReady?.() ? 'online' : 'starting' });
      if (p.startsWith('/api/')) return await api(req, res, url);

      // Discord login
      if (p === '/auth/login') {
        const missing = auth.missingConfig();
        if (missing.length) return send(res, 503, errorPage('Login is not set up', `Add ${missing.join(', ')} to the host's variables and restart.`), { 'content-type': 'text/html; charset=utf-8' });
        if (limited(req, 'login', 30)) return send(res, 429, 'Too many attempts, wait a minute.');
        const to = auth.authorizeUrl({ popup: url.searchParams.get('popup') === '1', handoff: url.searchParams.get('h'), next: url.searchParams.get('next') || '/app' });
        res.writeHead(302, headers({ location: to })); return res.end();
      }
      if (p === '/auth/callback') {
        const st = auth.verify(url.searchParams.get('state'));
        if (!st) return send(res, 400, errorPage('Login expired', 'That sign-in link is too old. Try again.'), { 'content-type': 'text/html; charset=utf-8' });
        if (url.searchParams.get('error')) return send(res, 400, errorPage('Login cancelled', 'Discord did not sign you in.'), { 'content-type': 'text/html; charset=utf-8' });
        let out;
        try { out = await auth.completeLogin(url.searchParams.get('code'), client); } catch (e) { return send(res, 502, errorPage('Discord said no', e.message), { 'content-type': 'text/html; charset=utf-8' }); }
        const set = auth.cookie(auth.SESSION_COOKIE, out.token, auth.config().ttl);
        if (st.h) auth.parkHandoff(st.h, out.token);
        if (st.popup) return send(res, 200, popupPage(out.token, st.h), { 'content-type': 'text/html; charset=utf-8', 'set-cookie': set });
        res.writeHead(302, headers({ location: st.next || '/app', 'set-cookie': set })); return res.end();
      }
      if (p === '/auth/handoff') {
        const t = auth.collectHandoff(url.searchParams.get('h'));
        return t ? json(res, 200, { token: t }) : fail(res, 404, 'pending');
      }
      if (p === '/auth/logout' && req.method === 'POST') { res.writeHead(204, headers({ 'set-cookie': auth.clearCookie(auth.SESSION_COOKIE) })); return res.end(); }

      // pages and files
      if (p === '/' || p === '/index.html') return file(res, path.join(PUBLIC, 'index.html'), { cache: 'no-cache' });
      if (p === '/app' || p.startsWith('/app/') || p.startsWith('/experiences/')) return file(res, path.join(PUBLIC, 'app.html'), { cache: 'no-cache' });   // Whop opens /experiences/<id>
      if (p.startsWith('/fonts/')) { const f = inside(FONTS, p.slice(7)); return f ? file(res, f, { cache: 'public, max-age=31536000, immutable' }) : send(res, 404, 'Not found'); }
      if (p.startsWith('/samples/')) { const f = inside(SAMPLES, p.slice(9)); return f ? file(res, f, { cache: 'public, max-age=86400' }) : send(res, 404, 'Not found'); }
      if (/^\/(css|js|img)\//.test(p) || p === '/favicon.svg') { const f = inside(PUBLIC, p.slice(1)); return f ? file(res, f) : send(res, 404, 'Not found'); }
      return send(res, 404, errorPage('Not found', 'There is nothing here.'), { 'content-type': 'text/html; charset=utf-8' });
    } catch (e) {
      client.logger?.error?.('[web] request failed', e);
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'server_error', e.status ? undefined : 'Something went wrong. It has been logged.');
    }
  });
}

let started = null;
function startWeb(client) {
  if (started || process.env.WEB_ENABLED === '0') return started;
  const port = Number(process.env.SERVER_PORT || process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0';
  started = createServer(client);
  started.on('error', (e) => client.logger?.error?.(`[web] could not listen on ${host}:${port}`, e));
  started.listen(port, host, () => {
    const c = auth.config(), missing = auth.missingConfig();
    client.logger?.info?.(`[web] journal site on ${c.baseUrl || `http://${host}:${port}`}${missing.length ? ` (login off until ${missing.join(', ')} are set)` : ''}${c.frameAncestors.length ? ` · embeddable in ${c.frameAncestors.join(' ')}` : ''}`);
  });
  return started;
}

module.exports = { createServer, startWeb };
