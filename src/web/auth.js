'use strict';
/**
 * Discord login for the web journal.
 *
 * Sessions are stateless: the cookie (or a Bearer token inside an embed) is a
 * JSON payload plus an HMAC, so a host restart never logs anyone out. Access
 * is re-checked on every request against the live bot: the server must still
 * have the bot, and the person must pass the same journal permission the
 * slash commands use (owner, an allowed user, or Manage Server).
 *
 * Inside an iframe (Whop) third-party cookies are often blocked and Discord's
 * login page refuses to be framed, so the embed signs in through a popup that
 * hands the session back with postMessage (and a short-lived handoff code as
 * a fallback for browsers that cut the opener link).
 */
const crypto = require('node:crypto');

const API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'jb_session';
const STATE_TTL_MS = 10 * 60 * 1000;
const MANAGE_GUILD = 0x20n, ADMINISTRATOR = 0x8n;

function config() {
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const days = Math.min(365, Math.max(1, Number(process.env.WEB_SESSION_DAYS) || 30));
  return {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    secret: process.env.SESSION_SECRET || '',
    baseUrl: base,
    redirectUri: base ? `${base}/auth/callback` : '',
    frameAncestors: (process.env.PANEL_FRAME_ANCESTORS || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    owners: (process.env.OWNER_ID || '').split(',').map((s) => s.trim()).filter(Boolean),
    ttl: days * 86400000,
  };
}
function missingConfig() {
  const c = config();
  return [['DISCORD_CLIENT_ID', c.clientId], ['DISCORD_CLIENT_SECRET', c.clientSecret], ['SESSION_SECRET', c.secret], ['PUBLIC_BASE_URL', c.baseUrl]].filter(([, v]) => !v).map(([k]) => k);
}
const embeddable = () => config().frameAncestors.length > 0;

const b64 = (s) => Buffer.from(s).toString('base64url');
function sign(payload, secret = config().secret) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
function verify(token, secret = config().secret) {
  if (typeof token !== 'string' || !secret) return null;
  const dot = token.lastIndexOf('.'); if (dot <= 0) return null;
  const body = token.slice(0, dot), mac = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64url'));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p && typeof p.exp === 'number' && p.exp > Date.now() ? p : null; } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('='); if (eq < 0) continue;
    try { out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* skip */ }
  }
  return out;
}
// in an embed the cookie has to cross sites: SameSite=None, and Partitioned (CHIPS) so browsers that block
// third-party cookies still keep one per embedding site
const cookieTail = () => (embeddable() ? 'SameSite=None; Partitioned' : 'SameSite=Lax');
const cookie = (name, value, ms) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; ${cookieTail()}; Max-Age=${Math.floor(ms / 1000)}`;
const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; ${cookieTail()}; Max-Age=0`;

function authorizeUrl({ popup = false, handoff = null, next = '/app' } = {}) {
  const c = config();
  const state = sign({ n: crypto.randomBytes(12).toString('base64url'), popup: !!popup, h: /^[\w-]{8,64}$/.test(handoff || '') ? handoff : null,
    next: /^\/app(\b|\/|#|$)/.test(next) ? next : '/app', exp: Date.now() + STATE_TTL_MS });
  const u = new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('client_id', c.clientId); u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', 'identify guilds'); u.searchParams.set('state', state); u.searchParams.set('prompt', 'none');
  return u.toString();
}

async function discord(path, init) {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`Discord ${path} answered ${res.status}`);
  return res.json();
}
const canManage = (g) => { if (g.owner) return true; try { const p = BigInt(g.permissions || 0); return (p & ADMINISTRATOR) === ADMINISTRATOR || (p & MANAGE_GUILD) === MANAGE_GUILD; } catch { return false; } };

/** exchanges the code; the session keeps the servers the bot shares with the person, and whether they can manage each */
async function completeLogin(code, client) {
  const c = config();
  const tok = await discord('/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: c.redirectUri }) });
  const bearer = { headers: { authorization: `Bearer ${tok.access_token}` } };
  const [user, guilds] = await Promise.all([discord('/users/@me', bearer), discord('/users/@me/guilds', bearer)]);
  const shared = guilds.filter((g) => client.guilds.cache.has(g.id)).map((g) => ({ id: g.id, m: canManage(g) ? 1 : 0 }));
  return { token: sign({ uid: user.id, name: user.global_name || user.username, avatar: user.avatar || null, g: shared, exp: Date.now() + c.ttl }), user };
}

function sessionFor(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) { const s = verify(h.slice(7).trim()); if (s) return s; }
  return verify(parseCookies(req)[SESSION_COOKIE]);
}
const isOwner = (uid) => config().owners.includes(String(uid));

/**
 * The journal permission, as the slash commands apply it: owners always; else the server's allowed users;
 * else (no allowlist) anyone who can manage the server. manage: may change settings.
 */
function accessTo(session, guildId, client, settings) {
  if (!session || !client.guilds.cache.has(guildId)) return null;
  const g = (session.g || []).find((x) => x.id === guildId);
  if (isOwner(session.uid)) return { journal: true, manage: true };
  const manage = !!g?.m;
  const listed = (settings.allowed_users || []).includes(session.uid);
  const journal = listed || (!(settings.allowed_users || []).length && manage);
  return journal || manage ? { journal, manage } : null;
}

const csrfFor = (s) => crypto.createHmac('sha256', config().secret).update(`csrf:${s.uid}:${s.exp}`).digest('base64url');
function csrfValid(s, token) {
  if (typeof token !== 'string') return false;
  const a = Buffer.from(csrfFor(s)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// popup -> embed handoff codes, kept for two minutes
const handoffs = new Map();
function parkHandoff(id, token) {
  if (!/^[\w-]{8,64}$/.test(id || '')) return;
  const now = Date.now();
  for (const [k, v] of handoffs) if (now - v.at > 120000) handoffs.delete(k);
  if (handoffs.size < 500) handoffs.set(id, { token, at: now });
}
function collectHandoff(id) {
  const e = handoffs.get(id); if (!e) return null;
  handoffs.delete(id);
  return Date.now() - e.at > 120000 ? null : e.token;
}

module.exports = { config, missingConfig, embeddable, sign, verify, parseCookies, cookie, clearCookie, authorizeUrl, completeLogin, sessionFor, accessTo, csrfFor, csrfValid,
  parkHandoff, collectHandoff, isOwner, SESSION_COOKIE };
