// Client du relais, partagé par le site web et les apps : compte, appareils, sessions, invités.

export const REASONS = {
  offline: "Cet appareil n'est pas en ligne : vérifie qu'il est allumé et que l'agent tourne.",
  busy: 'Quelqu’un contrôle déjà cet appareil.',
  refused: 'La connexion a été refusée sur l’appareil.',
  'no-permission': 'Sur le Mac, autorise Relais Distant Agent dans Réglages Système › Confidentialité et sécurité › Enregistrement de l’écran, puis relance l’agent.',
  capture: 'Le Mac n’a pas pu capturer son écran : vérifie l’autorisation Enregistrement de l’écran de Relais Distant Agent.',
  rate: 'Trop de tentatives : patiente une minute.',
  'bad-credentials': 'Nom d’utilisateur ou mot de passe incorrect.',
  'bad-username': 'Nom d’utilisateur : 3 à 32 caractères (lettres minuscules, chiffres, point, tiret).',
  'short-password': 'Le mot de passe doit faire au moins 8 caractères.',
  taken: 'Ce nom d’utilisateur est déjà pris.',
  token: 'Ta session a expiré : reconnecte-toi.',
  expired: 'Code inconnu ou expiré : vérifie-le, ou affiche un nouveau code sur l’autre appareil.',
  timeout: 'Pas de réponse.',
  error: 'Relais injoignable.',
};
export const reason = (r, fallback = 'Une erreur est survenue.') => REASONS[r] || fallback;

export function wsUrlFor(origin) {
  return origin.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
}

/** Connexion WebSocket au relais, avec attente de réponses typées. */
export class Relay {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.ws = null;
  }
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url));
      ws.onopen = () => {
        this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
        resolve(this);
      };
      ws.onerror = () => reject(new Error('relais injoignable'));
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        (this.handlers[m.t] || []).slice().forEach((f) => f(m));
      };
      ws.onclose = () => {
        clearInterval(this.ping);
        (this.handlers.close || []).forEach((f) => f());
      };
    });
  }
  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  wait(types, ms = 15000) {
    return new Promise((resolve) => {
      const fns = [];
      const done = (m) => {
        clearTimeout(t);
        types.forEach((ty, i) => { this.handlers[ty] = (this.handlers[ty] || []).filter((f) => f !== fns[i]); });
        resolve(m);
      };
      const t = setTimeout(() => done({ t: 'timeout', reason: 'timeout' }), ms);
      types.forEach((ty) => { const f = (m) => done(m); fns.push(f); this.on(ty, f); });
    });
  }
  async ask(msg, types, ms) {
    const p = this.wait(types, ms);
    this.send(msg);
    return p;
  }
  close() {
    try { this.ws && this.ws.close(); } catch {}
  }
}

/** Requête ponctuelle sur une connexion courte. */
export async function request(url, msg, expect, ms = 15000) {
  const r = new Relay(url);
  try { await r.connect(); } catch { return { t: 'error', reason: 'error' }; }
  const res = await r.ask(msg, expect, ms);
  r.close();
  return res;
}

/** Connexion ou création de compte : renvoie { t: 'auth', token, username } ou un échec. */
export function signIn(url, { mode, username, password, label, kind, temporary }) {
  return request(url, { t: mode === 'register' ? 'register' : 'login', username, password, label, kind, temporary: !!temporary }, ['auth', 'auth-fail'], 20000);
}

/** Session d'un compte : liste des appareils en direct, prise de contrôle, validation des invités. */
export class Account {
  constructor(url) {
    this.url = url;
    this.relay = new Relay(url);
    this.devices = [];
  }
  /** device : { id, name, kind } de l'appareil courant, pour qu'il figure dans « Mes appareils ». */
  async open(token, device) {
    try { await this.relay.connect(); } catch { return { t: 'error', reason: 'error' }; }
    const r = await this.relay.ask({ t: 'hello', token, device }, ['ready', 'auth-fail']);
    if (r.t === 'ready') {
      this.username = r.username;
      this.deviceId = r.deviceId;
      this.guest = r.guest;
      this.expires = r.expires;
      this.devices = r.devices;
      this.relay.on('devices', (m) => { this.devices = m.devices; if (this.onDevices) this.onDevices(m.devices); });
    }
    return r;
  }
  /** Demande le contrôle d'un appareil : { t: 'ok', ice } quand l'appareil accepte. */
  async connect(deviceId) {
    const r = await this.relay.ask({ t: 'connect', deviceId }, ['connecting', 'connect-fail']);
    if (r.t !== 'connecting') return r;
    const a = await this.relay.wait(['accepted', 'connect-fail'], 20000);
    return a.t === 'accepted' ? { t: 'ok', ice: r.ice } : a;
  }
  end() { this.relay.send({ t: 'end' }); }
  /** target : { linkId } (QR code) ou { code } (code à usage unique). */
  peekLink(target) { return this.relay.ask({ t: 'peek-link', ...target }, ['peek']); }
  approveLink(target) { return this.relay.ask({ t: 'link-approve', ...target }, ['link-ok', 'link-fail']); }
  hostToken(label) { return this.relay.ask({ t: 'host-token', label }, ['host-token', 'host-token-fail']); }
  setPassword(password) { return this.relay.ask({ t: 'set-password', password }, ['password-ok', 'password-fail']); }
  removeDevice(deviceId) { this.relay.send({ t: 'remove-device', deviceId }); }
  revokeGuests() { return this.relay.ask({ t: 'revoke-guests' }, ['guests-revoked']); }
  async logout() { await this.relay.ask({ t: 'logout' }, ['bye'], 5000); this.relay.close(); }
  close() { this.relay.close(); }
}

/**
 * Connexion par QR code : cet appareil affiche un code, un appareil déjà connecté le valide.
 * mode : 'temp' (12 h), 'perm' (sans limite) ou 'host' (appareil contrôlable).
 */
export async function startGuest(url, { mode = 'temp', label = '', kind = 'web' } = {}) {
  const relay = new Relay(url);
  await relay.connect();
  const link = await relay.ask({ t: 'guest-hello', mode, label, kind }, ['link']);
  if (link.t !== 'link') throw new Error('relais injoignable');
  return { relay, linkId: link.linkId, code: link.code, expires: link.expires, authorized: relay.wait(['auth'], 24 * 3600 * 1000) };
}

/** Code à usage unique affiché en deux groupes : « K7P 4QX ». */
export const formatCode = (c) => (c ? `${c.slice(0, 3)} ${c.slice(3)}` : '');

/** Décode ce que l'utilisateur a saisi ou scanné : code à usage unique ou lien de QR code. */
export function parseTarget(text) {
  const link = parseLink(text);
  if (link) return { linkId: link.linkId, origin: link.origin };
  const code = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return code.length === 6 ? { code } : null;
}

/** Décode un lien de QR code Relais Distant. */
export function parseLink(text) {
  try {
    const u = new URL(String(text).trim());
    const p = new URLSearchParams(u.hash.slice(1));
    if (p.get('link')) return { kind: 'link', origin: u.origin, linkId: p.get('link') };
  } catch {}
  return null;
}

/** Texte expliquant à l'appareil qui valide ce que l'autre appareil obtiendra. */
export function linkModeText(mode) {
  if (mode === 'perm') return { title: 'Connecter cet appareil ?', text: 'Il restera connecté à ton compte, sans limite de durée. Tu pourras le retirer quand tu veux.', button: 'Connecter' };
  if (mode === 'host') return { title: 'Ajouter cet appareil ?', text: 'Il rejoindra « Mes appareils » et tu pourras le contrôler à distance.', button: 'Ajouter' };
  return { title: 'Connecter temporairement ?', text: 'Il verra tes appareils et pourra les contrôler pendant 12 heures au plus.', button: 'Connecter 12 h' };
}

export const KIND_INFO = {
  mac: { icon: 'desktop', label: 'Mac' },
  windows: { icon: 'windows-logo', label: 'PC Windows' },
  linux: { icon: 'linux-logo', label: 'PC Linux' },
  android: { icon: 'android-logo', label: 'Android' },
  ipad: { icon: 'device-tablet', label: 'iPad' },
  iphone: { icon: 'device-mobile', label: 'iPhone' },
  web: { icon: 'globe', label: 'Navigateur' },
};
export const kindInfo = (k) => KIND_INFO[k] || KIND_INFO.web;

/** Identifiant stable de cet appareil (pour « Mes appareils »). */
export function localDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('deviceId', id);
  }
  return id;
}

/** Pourquoi un appareil ne peut pas être contrôlé. */
export function notControllableReason(kind) {
  if (kind === 'iphone' || kind === 'ipad') return 'Apple ne permet pas de le contrôler';
  return 'Agent pas encore installé';
}

/** Type de l'appareil courant (pour nommer ses connexions). */
export function localKind() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'web';
}

export function describeUA(ua = '') {
  const os = /Windows/.test(ua) ? 'PC Windows' : /Android/.test(ua) ? 'Android' : /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'PC Linux' : 'Navigateur';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

export function deviceIconForUA(ua = '') {
  if (/Windows/.test(ua)) return 'windows-logo';
  if (/Android/.test(ua)) return 'android-logo';
  if (/iPhone|iPad|Mac OS/.test(ua)) return 'apple-logo';
  if (/Linux/.test(ua)) return 'linux-logo';
  return 'globe';
}

export function lastSeen(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR')}`;
}
