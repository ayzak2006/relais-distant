// Relais Distant : comptes, appareils et mise en relation, sur Cloudflare Workers (offre gratuite).
// Il ne voit jamais l'écran : la vidéo et les commandes passent en WebRTC direct entre appareils.
//
// Un seul Durable Object (« hub ») tient toutes les connexions WebSocket avec l'API d'hibernation :
// entre deux messages il dort et ne consomme rien. Comptes, jetons et appareils sont en SQLite,
// l'état de chaque connexion dans son « attachment ».

import { DurableObject } from 'cloudflare:workers';
import qrcode from 'qrcode-generator';

const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const KINDS = new Set(['mac', 'windows', 'linux', 'android', 'ipad', 'iphone', 'web']);
const PBKDF2_ITER = 100000; // maximum accepté par WebCrypto sur Workers
const GUEST_TTL = 12 * 3600 * 1000;
const CODE_TTL = 10 * 60 * 1000;
// Code à usage unique : 6 caractères sans ambiguïté (pas de 0/O, 1/I/L).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const normCode = (c) => str(c, 20).toUpperCase().replace(/[^0-9A-Z]/g, '');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname === '/qr.svg') return qrSvg(url.searchParams.get('d') || '');
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
      return env.HUB.getByName('hub').fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

function qrSvg(data) {
  if (data.length > 500) return new Response('trop long', { status: 400 });
  const qr = qrcode(0, 'M');
  qr.addData(data, 'Byte');
  qr.make();
  return new Response(qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
  });
}

// ---------- Cryptographie ----------
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const rid = (n = 16) => b64(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256)));
}
const ctEq = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, created INTEGER NOT NULL, expires INTEGER);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    `);
    // Évolutions du schéma : appareils non contrôlables (téléphones…) et jeton associé à l'appareil.
    for (const sql of ['ALTER TABLE devices ADD COLUMN controllable INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE devices ADD COLUMN token TEXT']) {
      try { this.sql.exec(sql); } catch {}
    }
    this.buckets = new Map();
    this.ice = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (env.TURN_URL) this.ice.push({ urls: env.TURN_URL.split(','), username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: 'none',
      ip: request.headers.get('CF-Connecting-IP') || '',
      ua: str(request.headers.get('User-Agent') || ''),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- Outils ----------
  att(ws) { return ws.deserializeAttachment() || {}; }
  save(ws, a) { ws.serializeAttachment(a); }
  send(ws, msg) { try { if (ws) ws.send(JSON.stringify(msg)); } catch {} }
  sockets() { return this.ctx.getWebSockets().map((ws) => ({ ws, a: this.att(ws) })); }
  find(pred) { const r = this.sockets().find(({ a }) => pred(a)); return r && r.ws; }
  hostWs(deviceId) { return this.find((a) => a.role === 'host' && a.deviceId === deviceId); }
  allow(key, max, windowMs) {
    const now = Date.now();
    const b = this.buckets.get(key) || { n: 0, t: now };
    if (now - b.t > windowMs) { b.n = 0; b.t = now; }
    b.n++;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.buckets.clear();
    return b.n <= max;
  }

  devicesOf(account) {
    const socks = this.sockets().filter(({ a }) => a.account === account);
    const hosts = new Set(socks.filter(({ a }) => a.role === 'host').map(({ a }) => a.deviceId));
    const apps = new Set(socks.filter(({ a }) => a.role === 'client' && a.deviceId).map(({ a }) => a.deviceId));
    return this.sql.exec('SELECT id, name, kind, last_seen, controllable FROM devices WHERE account = ? ORDER BY name', account).toArray()
      .map((d) => ({
        id: d.id, name: d.name, kind: d.kind, lastSeen: d.last_seen,
        controllable: !!d.controllable,
        // « En ligne » : contrôlable maintenant (agent connecté), ou app ouverte pour les autres.
        online: d.controllable ? hosts.has(d.id) : apps.has(d.id),
      }));
  }
  /** Prévient toutes les apps et pages connectées au compte que la liste a changé. */
  pushDevices(account) {
    const devices = this.devicesOf(account);
    for (const { ws, a } of this.sockets()) if (a.role === 'client' && a.account === account) this.send(ws, { t: 'devices', devices });
  }

  async issueToken(account, kind, label, ttl) {
    const token = rid(32);
    const now = Date.now();
    this.sql.exec('INSERT INTO tokens (hash, account, kind, label, created, expires) VALUES (?, ?, ?, ?, ?, ?)',
      await sha256(token), account, kind, label, now, ttl ? now + ttl : null);
    return token;
  }
  async resolveToken(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const hash = await sha256(token);
    const row = this.sql.exec(
      'SELECT t.hash, t.account, t.kind, t.label, t.expires, a.username FROM tokens t JOIN accounts a ON a.id = t.account WHERE t.hash = ?', hash,
    ).toArray()[0];
    if (!row) return null;
    if (row.expires && row.expires < Date.now()) { this.sql.exec('DELETE FROM tokens WHERE hash = ?', hash); return null; }
    return row;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 256 * 1024) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { await this.handle(ws, m); } catch (e) { console.error('message', m.t, e); }
  }
  async webSocketClose(ws, code) { this.onClose(ws); try { ws.close(code === 1005 ? 1000 : code, 'fin'); } catch {} }
  async webSocketError(ws) { this.onClose(ws); }

  async handle(ws, m) {
    const me = this.att(ws);
    switch (m.t) {
      // ----- Compte -----
      case 'register': case 'login': {
        if (!this.allow(`auth|${me.ip}`, 10, 60000)) return this.send(ws, { t: 'auth-fail', reason: 'rate' });
        const username = str(m.username, 32).trim().toLowerCase();
        const password = str(m.password, 200);
        const kind = KINDS.has(m.kind) ? m.kind : 'web';
        const label = str(m.label, 60) || 'Appareil';
        if (!USER_RE.test(username)) return this.send(ws, { t: 'auth-fail', reason: 'bad-username' });
        if (password.length < 8) return this.send(ws, { t: 'auth-fail', reason: 'short-password' });
        let acc = this.sql.exec('SELECT id, salt, hash FROM accounts WHERE username = ?', username).toArray()[0];
        if (m.t === 'register') {
          if (acc) return this.send(ws, { t: 'auth-fail', reason: 'taken' });
          const salt = crypto.getRandomValues(new Uint8Array(16));
          acc = { id: rid(12) };
          this.sql.exec('INSERT INTO accounts (id, username, salt, hash, created) VALUES (?, ?, ?, ?, ?)', acc.id, username, b64(salt), await pbkdf2(password, salt), Date.now());
        } else {
          if (!this.allow(`user|${username}`, 8, 300000)) return this.send(ws, { t: 'auth-fail', reason: 'rate' });
          const hash = acc ? await pbkdf2(password, unb64(acc.salt)) : await pbkdf2(password, new Uint8Array(16));
          if (!acc || !ctEq(hash, acc.hash)) return this.send(ws, { t: 'auth-fail', reason: 'bad-credentials' });
        }
        const temporary = !m.host && m.temporary === true;
        const token = await this.issueToken(acc.id, m.host ? 'host' : temporary ? 'guest' : 'client', label, temporary ? GUEST_TTL : null);
        return this.send(ws, { t: 'auth', token, username, mode: m.host ? 'host' : temporary ? 'temp' : 'perm' });
      }
      case 'hello': {
        const tok = await this.resolveToken(m.token);
        if (!tok) return this.send(ws, { t: 'auth-fail', reason: 'token' });
        Object.assign(me, { role: 'client', account: tok.account, username: tok.username, tokenHash: tok.hash, label: tok.label, guest: tok.kind === 'guest', deviceId: null });
        const dev = m.device || {};
        if (!me.guest && /^[A-Za-z0-9_-]{16,64}$/.test(str(dev.id))) {
          const row = this.sql.exec('SELECT account FROM devices WHERE id = ?', dev.id).toArray()[0];
          if (!row || row.account === tok.account) {
            const name = str(dev.name, 40).trim() || 'Appareil';
            const kind = KINDS.has(dev.kind) ? dev.kind : 'web';
            // Un appareil non contrôlable (téléphone, tablette) corrige ici son nom et son type s'ils ont changé.
            if (row) this.sql.exec('UPDATE devices SET last_seen = ?, token = ?, kind = CASE WHEN controllable = 0 THEN ? ELSE kind END, name = CASE WHEN controllable = 0 THEN ? ELSE name END WHERE id = ?', Date.now(), tok.hash, kind, name, dev.id);
            else this.sql.exec('INSERT INTO devices (id, account, name, kind, created, last_seen, controllable, token) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', dev.id, tok.account, name, kind, Date.now(), Date.now(), tok.hash);
            me.deviceId = dev.id;
          }
        }
        this.save(ws, me);
        this.send(ws, { t: 'ready', username: tok.username, guest: me.guest, expires: tok.expires, deviceId: me.deviceId, devices: this.devicesOf(tok.account) });
        if (me.deviceId) this.pushDevices(tok.account);
        return;
      }
      case 'host-token': {
        if (me.role !== 'client' || me.guest) return this.send(ws, { t: 'host-token-fail', reason: 'token' });
        const token = await this.issueToken(me.account, 'host', str(m.label, 60) || 'Agent', null);
        return this.send(ws, { t: 'host-token', token, username: me.username });
      }
      case 'set-password': {
        if (me.role !== 'client' || me.guest) return this.send(ws, { t: 'password-fail', reason: 'token' });
        const password = str(m.password, 200);
        if (password.length < 8) return this.send(ws, { t: 'password-fail', reason: 'short-password' });
        const salt = crypto.getRandomValues(new Uint8Array(16));
        this.sql.exec('UPDATE accounts SET salt = ?, hash = ? WHERE id = ?', b64(salt), await pbkdf2(password, salt), me.account);
        return this.send(ws, { t: 'password-ok' });
      }
      case 'logout': {
        if (me.tokenHash) this.sql.exec('DELETE FROM tokens WHERE hash = ?', me.tokenHash);
        this.endSession(ws, me);
        Object.assign(me, { role: 'none', account: null, tokenHash: null });
        this.save(ws, me);
        return this.send(ws, { t: 'bye' });
      }

      // ----- Ordinateur d'un ami : QR code puis validation par un appareil connecté -----
      case 'guest-hello': {
        if (me.role !== 'none') return;
        me.role = 'guest-wait'; me.linkId = rid();
        me.linkMode = ['temp', 'perm', 'host'].includes(m.mode) ? m.mode : 'temp';
        me.linkLabel = str(m.label, 60) || '';
        me.linkKind = KINDS.has(m.kind) ? m.kind : 'web';
        do { me.linkCode = newCode(); } while (this.find((a) => a.role === 'guest-wait' && a.linkCode === me.linkCode));
        me.linkExp = Date.now() + CODE_TTL;
        this.save(ws, me);
        return this.send(ws, { t: 'link', linkId: me.linkId, code: me.linkCode, expires: me.linkExp, mode: me.linkMode });
      }
      case 'peek-link': {
        if (m.code && !this.allow(`code|${me.ip}`, 12, 60000)) return this.send(ws, { t: 'peek', ok: false, reason: 'rate' });
        const g = this.waitingGuest(m);
        const ga = g && this.att(g);
        return this.send(ws, ga ? { t: 'peek', ok: true, ua: ga.ua, ip: ga.ip, mode: ga.linkMode, label: ga.linkLabel, kind: ga.linkKind } : { t: 'peek', ok: false });
      }
      case 'link-approve': {
        if (me.role !== 'client' || me.guest) return this.send(ws, { t: 'link-fail', reason: 'token' });
        if (!this.allow(`link|${me.ip}`, 20, 60000)) return this.send(ws, { t: 'link-fail', reason: 'rate' });
        const g = this.waitingGuest(m);
        if (!g) return this.send(ws, { t: 'link-fail', reason: 'expired' });
        const ga = this.att(g);
        const mode = ga.linkMode || 'temp';
        const label = ga.linkLabel || (mode === 'temp' ? 'Invité ' : '') + describeUA(ga.ua);
        const kind = mode === 'host' ? 'host' : mode === 'perm' ? 'client' : 'guest';
        const token = await this.issueToken(me.account, kind, label, mode === 'temp' ? GUEST_TTL : null);
        ga.role = 'none'; ga.linkId = null; ga.linkCode = null; this.save(g, ga);
        this.send(g, { t: 'auth', token, username: me.username, guest: mode === 'temp', mode });
        return this.send(ws, { t: 'link-ok', mode });
      }
      case 'revoke-guests': {
        if (me.role !== 'client' || me.guest) return;
        this.sql.exec("DELETE FROM tokens WHERE account = ? AND kind = 'guest'", me.account);
        for (const { ws: w, a } of this.sockets()) {
          if (a.role === 'client' && a.guest && a.account === me.account) { this.endSession(w, a); this.send(w, { t: 'auth-fail', reason: 'token' }); try { w.close(4001, 'révoqué'); } catch {} }
        }
        return this.send(ws, { t: 'guests-revoked' });
      }

      // ----- Appareil contrôlable (agent) -----
      case 'host-hello': {
        const tok = await this.resolveToken(m.token);
        if (!tok || tok.kind !== 'host') return this.send(ws, { t: 'error', reason: 'token' });
        const deviceId = /^[A-Za-z0-9_-]{16,64}$/.test(str(m.deviceId)) ? m.deviceId : rid(12);
        const name = str(m.name, 40).trim() || 'Appareil';
        const kind = KINDS.has(m.kind) ? m.kind : 'mac';
        const now = Date.now();
        const existing = this.sql.exec('SELECT account FROM devices WHERE id = ?', deviceId).toArray()[0];
        if (existing && existing.account !== tok.account) return this.send(ws, { t: 'error', reason: 'device-owned' });
        if (existing) this.sql.exec('UPDATE devices SET name = ?, kind = ?, last_seen = ?, controllable = 1 WHERE id = ?', name, kind, now, deviceId);
        else this.sql.exec('INSERT INTO devices (id, account, name, kind, created, last_seen, controllable) VALUES (?, ?, ?, ?, ?, ?, 1)', deviceId, tok.account, name, kind, now, now);
        const prev = this.hostWs(deviceId);
        if (prev && prev !== ws) { const pa = this.att(prev); pa.role = 'none'; this.save(prev, pa); try { prev.close(4000, 'remplacé'); } catch {} }
        Object.assign(me, { role: 'host', account: tok.account, deviceId, name, tokenHash: tok.hash });
        this.save(ws, me);
        this.send(ws, { t: 'welcome', deviceId, username: tok.username, ice: this.ice });
        return this.pushDevices(tok.account);
      }
      case 'accept': case 'refuse': case 'kick': {
        if (me.role !== 'host') return;
        const c = this.find((a) => a.role === 'client' && a.sid === str(m.sid) && a.target === me.deviceId);
        if (!c) return;
        const ca = this.att(c);
        if (m.t === 'accept') { ca.accepted = true; this.save(c, ca); return this.send(c, { t: 'accepted', sid: ca.sid }); }
        ca.sid = null; ca.target = null; ca.accepted = false; this.save(c, ca);
        const why = str(m.reason, 30) || (m.t === 'refuse' ? 'refused' : '');
        return this.send(c, { t: m.t === 'refuse' ? 'connect-fail' : 'kicked', reason: why || undefined });
      }
      case 'remove-device': {
        if (me.role !== 'client' || me.guest) return;
        const id = str(m.deviceId);
        const row = this.sql.exec('SELECT token FROM devices WHERE id = ? AND account = ?', id, me.account).toArray()[0];
        if (row && row.token) this.sql.exec('DELETE FROM tokens WHERE hash = ?', row.token);
        this.sql.exec('DELETE FROM devices WHERE id = ? AND account = ?', id, me.account);
        for (const { ws: w, a } of this.sockets()) {
          if (w !== ws && a.role === 'client' && a.deviceId === id && a.account === me.account) { this.send(w, { t: 'auth-fail', reason: 'token' }); try { w.close(4001, 'retiré'); } catch {} }
        }
        const h = this.hostWs(id);
        if (h && this.att(h).account === me.account) {
          const ha = this.att(h);
          if (ha.tokenHash) this.sql.exec('DELETE FROM tokens WHERE hash = ?', ha.tokenHash);
          this.send(h, { t: 'error', reason: 'token' });
          try { h.close(4001, 'retiré'); } catch {}
        }
        return this.pushDevices(me.account);
      }

      // ----- Session de contrôle -----
      case 'connect': {
        if (me.role !== 'client') return this.send(ws, { t: 'connect-fail', reason: 'token' });
        // Un jeton d'invité expire même si la page reste ouverte.
        if (me.guest) {
          const row = this.sql.exec('SELECT expires FROM tokens WHERE hash = ?', me.tokenHash).toArray()[0];
          if (!row || (row.expires && row.expires < Date.now())) return this.send(ws, { t: 'connect-fail', reason: 'token' });
        }
        const deviceId = str(m.deviceId);
        const h = this.hostWs(deviceId);
        if (!h || this.att(h).account !== me.account) return this.send(ws, { t: 'connect-fail', reason: 'offline' });
        if (this.find((a) => a.role === 'client' && a.target === deviceId && a.accepted)) return this.send(ws, { t: 'connect-fail', reason: 'busy' });
        this.endSession(ws, me);
        me.sid = rid(); me.target = deviceId; me.accepted = false; this.save(ws, me);
        this.send(ws, { t: 'connecting', sid: me.sid, ice: this.ice });
        return this.send(h, { t: 'incoming', sid: me.sid, from: { label: me.label, guest: !!me.guest, ip: me.ip, ua: me.ua } });
      }
      case 'end': {
        this.endSession(ws, me);
        this.save(ws, me);
        return;
      }
      case 'signal': {
        if (me.role === 'client' && me.sid && me.accepted) {
          return this.send(this.hostWs(me.target), { t: 'signal', sid: me.sid, data: m.data });
        }
        if (me.role === 'host') {
          const c = this.find((a) => a.role === 'client' && a.sid === str(m.sid) && a.target === me.deviceId && a.accepted);
          if (c) this.send(c, { t: 'signal', data: m.data });
        }
        return;
      }
    }
  }

  /** Appareil en attente de connexion, retrouvé par son lien (QR code) ou son code à usage unique. */
  waitingGuest(m) {
    const code = normCode(m.code);
    const linkId = str(m.linkId);
    const now = Date.now();
    if (code) return this.find((a) => a.role === 'guest-wait' && a.linkCode === code && a.linkExp > now);
    if (linkId) return this.find((a) => a.role === 'guest-wait' && a.linkId === linkId);
    return null;
  }

  /** Termine la session en cours d'un client (le Mac est prévenu). */
  endSession(ws, a) {
    if (a.role === 'client' && a.sid && a.target) this.send(this.hostWs(a.target), { t: 'peer-left', sid: a.sid });
    a.sid = null; a.target = null; a.accepted = false;
  }

  onClose(ws) {
    const a = this.att(ws);
    if (a.role === 'host') {
      for (const { ws: w, a: ca } of this.sockets()) {
        if (w !== ws && ca.role === 'client' && ca.target === a.deviceId) {
          this.send(w, { t: 'host-left' });
          ca.sid = null; ca.target = null; ca.accepted = false; this.save(w, ca);
        }
      }
      this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), a.deviceId);
      a.role = 'closed';
      try { this.save(ws, a); } catch {}
      return this.pushDevices(a.account);
    }
    this.endSession(ws, a);
    const wasApp = a.role === 'client' && a.deviceId;
    if (wasApp) this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), a.deviceId);
    a.role = 'closed';
    try { this.save(ws, a); } catch {}
    if (wasApp) this.pushDevices(a.account);
  }
}

function describeUA(ua = '') {
  const os = /Windows/.test(ua) ? 'PC Windows' : /Android/.test(ua) ? 'Android' : /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'PC Linux' : 'navigateur';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os}, ${br}` : os;
}
