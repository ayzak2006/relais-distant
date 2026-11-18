// App Relais Distant : ton compte, tes appareils, et la connexion de l'ordinateur d'un ami par QR code.
import { Account, signIn, startGuest, reason, parseLink, parseTarget, formatCode, describeUA, deviceIconForUA, kindInfo, lastSeen, localKind, linkModeText, localDeviceId, wsUrlFor } from './shared/relay.js';
import { renderDevices, qrSvg } from './shared/devices.js';
import { Remote } from './shared/remote.js';

const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_RELAY = 'https://relais-distant.relais-distant-worker.workers.dev';
const mobile = !!(T && T.barcodeScanner);
const relayOrigin = () => localStorage.getItem('relay') || DEFAULT_RELAY;
const url = () => wsUrlFor(relayOrigin());
const alertBox = (msg) => (msg ? `<i class="ph ph-warning-circle"></i><span>${esc(msg)}</span>` : '');
const showError = (msg) => { $('error').innerHTML = alertBox(msg); };
const deviceLabel = () => ({ ipad: 'iPad', iphone: 'iPhone', android: 'Android', windows: 'PC Windows', mac: 'Mac', linux: 'PC Linux' }[kindNow()] || 'Appareil');
const kindNow = () => nativeKind || localKind();

let account = null, remote = null, busyId = null;

// Jeton : permanent dans localStorage, temporaire dans sessionStorage (effacé à la fermeture de l'app).
const getToken = () => localStorage.getItem('token') || sessionStorage.getItem('token');
const saveToken = (t, temporary) => { clearToken(); (temporary ? sessionStorage : localStorage).setItem('token', t); };
const clearToken = () => { localStorage.removeItem('token'); sessionStorage.removeItem('token'); };

// ---------- Premier lancement : type de connexion puis méthode ----------
let obMode = 'perm', authMode = 'login', guest = null, codeTimer = null;

function showOnboard() {
  closeGuest();
  $('home').hidden = true;
  $('onboard').hidden = false;
  $('ob-choose').hidden = false;
  $('ob-method').hidden = true;
}
function closeGuest() {
  if (guest) { guest.relay.close(); guest = null; }
}
document.querySelectorAll('.choice[data-mode]').forEach((b) => {
  b.onclick = () => { obMode = b.dataset.mode; showMethod(); };
});
$('ob-back').onclick = showOnboard;

function showMethod() {
  $('ob-choose').hidden = true;
  $('ob-method').hidden = false;
  $('ob-mode').innerHTML = obMode === 'temp' ? '<i class="ph ph-clock"></i>Temporaire, 12 h' : '<i class="ph ph-lock-key"></i>Permanente';
  $('ob-form').hidden = true;
  $('ob-show-form').hidden = false;
  $('ob-error').innerHTML = '';
  startQR();
}

async function startQR() {
  closeGuest();
  $('ob-qr').innerHTML = '<div class="skeleton"></div>';
  let g;
  try {
    g = guest = await startGuest(url(), { mode: obMode, label: deviceLabel(), kind: kindNow() });
  } catch {
    $('ob-error').innerHTML = alertBox(reason('error'));
    return setTimeout(() => { if (!$('ob-method').hidden) startQR(); }, 3000);
  }
  const link = `${relayOrigin()}/p#link=${g.linkId}`;
  $('ob-qr').innerHTML = qrSvg(link);
  $('ob-code').textContent = formatCode(g.code);
  // Le code à usage unique expire au bout de 10 minutes : on en affiche un nouveau avant.
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => { if (guest === g && !$('ob-method').hidden) startQR(); }, Math.max(30000, g.expires - Date.now() - 20000));
  g.relay.on('close', () => { if (guest === g && !$('ob-method').hidden) setTimeout(startQR, 1500); });
  const auth = await g.authorized;
  if (guest !== g || auth.t !== 'auth') return;
  guest = null;
  g.relay.close();
  saveToken(auth.token, auth.mode === 'temp');
  open(auth.token);
}

$('ob-show-form').onclick = () => {
  $('ob-show-form').hidden = true;
  $('ob-form').hidden = false;
  $('ob-user').focus();
};
document.querySelectorAll('[data-auth]').forEach((b) => {
  b.onclick = () => {
    authMode = b.dataset.auth;
    document.querySelectorAll('[data-auth]').forEach((x) => x.classList.toggle('on', x === b));
    $('ob-go').textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
    $('ob-error').innerHTML = '';
  };
});
$('ob-form').onsubmit = async (e) => {
  e.preventDefault();
  $('ob-go').disabled = true;
  const r = await signIn(url(), {
    mode: authMode, username: $('ob-user').value.trim().toLowerCase(), password: $('ob-pass').value,
    label: deviceLabel(), kind: kindNow(), temporary: obMode === 'temp',
  });
  $('ob-go').disabled = false;
  if (r.t !== 'auth') { $('ob-error').innerHTML = alertBox(reason(r.reason)); return; }
  $('ob-pass').value = '';
  closeGuest();
  saveToken(r.token, obMode === 'temp');
  open(r.token);
};

// ---------- Mes appareils ----------
// Sur Mac, l'app partage l'identité de l'agent local : le Mac n'apparaît qu'une fois, et devient contrôlable.
const isMacApp = !!(T && T.core) && !mobile && localKind() === 'mac';
let thisMac = null;

/** Type réel de l'appareil : le modèle matériel sur iPhone et iPad, sinon le système. */
let nativeKind = null;
async function realKind() {
  if (nativeKind) return nativeKind;
  nativeKind = localKind();
  if (mobile) {
    try {
      const model = await T.core.invoke('device_model');
      if (model.startsWith('iPad')) nativeKind = 'ipad';
      else if (model.startsWith('iPhone') || model.startsWith('iPod')) nativeKind = 'iphone';
    } catch {}
  }
  return nativeKind;
}
const KIND_NAMES = { ipad: 'iPad', iphone: 'iPhone', android: 'Android', windows: 'PC Windows', mac: 'Mac', linux: 'PC Linux' };

async function thisDevice() {
  if (isMacApp) {
    try { thisMac = await T.core.invoke('this_mac'); return { id: thisMac.id, name: thisMac.name, kind: 'mac' }; } catch {}
  }
  const kind = await realKind();
  return { id: localDeviceId(), name: KIND_NAMES[kind] || 'Appareil', kind };
}

/** Connecte l'agent de ce Mac au compte, s'il ne l'est pas déjà. */
async function linkMacAgent() {
  if (!isMacApp || !thisMac || account.guest) return;
  if (thisMac.agentLinked && thisMac.agentUser === account.username) return;
  const r = await account.hostToken(thisMac.name);
  if (r.t !== 'host-token') return;
  try {
    const started = await T.core.invoke('link_agent', {
      token: r.token, server: relayOrigin().replace(/^http/, 'ws'), username: account.username, deviceId: thisMac.id, name: thisMac.name,
    });
    thisMac.agentLinked = true;
    thisMac.agentUser = account.username;
    if (!started) showError('Installe Relais Distant Agent sur ce Mac pour pouvoir le contrôler à distance.');
  } catch {}
}

async function open(token) {
  account = new Account(url());
  const device = await thisDevice();
  const r = await account.open(token, device);
  if (r.t === 'auth-fail') { clearToken(); account = null; return showOnboard(); }
  if (r.t !== 'ready') {
    $('onboard').hidden = true;
    $('home').hidden = false;
    showError(reason('error'));
    return setTimeout(() => open(token), 3000);
  }
  $('onboard').hidden = true;
  $('home').hidden = false;
  showError('');
  $('btn-account').textContent = account.username.slice(0, 1).toUpperCase();
  $('temp-pill').hidden = !account.guest;
  if (account.guest && account.expires) {
    $('temp-pill').innerHTML = `<i class="ph ph-clock"></i>Jusqu’à ${new Date(account.expires).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  $('link-group').hidden = !!account.guest;
  $('link-sub').textContent = mobile ? 'Code à usage unique ou QR code' : 'Avec le code à usage unique affiché sur l’autre appareil';
  account.onDevices = render;
  linkMacAgent();
  account.relay.on('signal', (m) => remote && remote.onSignal(m.data));
  account.relay.on('kicked', (m) => remote && remote.end(m.reason ? reason(m.reason) : 'L’appareil a coupé la session.'));
  account.relay.on('host-left', () => remote && remote.end('L’appareil s’est déconnecté.'));
  account.relay.on('auth-fail', () => { clearToken(); location.reload(); });
  account.relay.on('close', () => {
    if (account && account.leaving) return;
    if (remote) remote.end('Connexion au relais perdue.');
    else setTimeout(() => open(token), 1500);
  });
  render();
}

function render() {
  renderDevices($('tiles'), account.devices, {
    busyId,
    selfId: account.deviceId,
    onConnect: control,
    onMore: deviceOptions,
    empty: 'Installe Relais Distant Agent sur ton Mac et connecte-le à ce compte : il apparaîtra ici, prêt à être contrôlé.',
  });
}

async function control(device) {
  showError('');
  busyId = device.id;
  render();
  const r = await account.connect(device.id);
  busyId = null;
  render();
  if (r.t !== 'ok') return showError(reason(r.reason || r.t));
  $('home').hidden = true;
  remote = new Remote({
    ice: r.ice,
    host: device.name,
    title: `${device.name} · Relais Distant`,
    sendSignal: (data) => account.relay.send({ t: 'signal', data }),
    onEnd: () => account.end(),
    endAction: {
      label: 'Mes appareils',
      icon: 'arrow-left',
      run: () => { remote.destroy(); remote = null; $('home').hidden = false; document.title = 'Relais Distant'; render(); },
    },
  });
}

// ---------- Feuilles ----------
function sheet(html) {
  $('sheet-body').innerHTML = html;
  if (!$('sheet').open) $('sheet').showModal();
  return $('sheet-body');
}
const closeSheet = () => $('sheet').close();
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

function deviceOptions(d) {
  const k = kindInfo(d.kind);
  const b = sheet(`<div class="hero-icon neutral"><i class="ph ph-${k.icon}"></i></div>
    <h2>${esc(d.name)}</h2>
    <p>${esc(k.label)}. ${d.id === account.deviceId ? "C'est l'appareil que tu utilises." : !d.controllable ? (d.kind === 'iphone' || d.kind === 'ipad' ? 'Il peut contrôler tes appareils, mais Apple ne permet pas de le contrôler.' : "Il peut contrôler tes appareils ; installe l'agent pour le contrôler lui aussi.") : d.online ? 'En ligne, prêt à être contrôlé.' : 'Vu ' + esc(lastSeen(d.lastSeen)) + '.'}</p>
    <div class="sheet-actions"><button class="btn btn-quiet" id="cancel">Fermer</button><button class="btn btn-danger" id="del"><i class="ph ph-trash"></i>Retirer</button></div>`);
  b.querySelector('#cancel').onclick = closeSheet;
  b.querySelector('#del').onclick = () => { account.removeDevice(d.id); closeSheet(); };
}

$('btn-account').onclick = () => {
  const b = sheet(`<div class="hero-icon"><i class="ph ph-user"></i></div>
    <h2>Mon compte</h2>
    <p>${account.guest ? 'Connexion temporaire sur cet appareil.' : 'Connexion permanente sur cet appareil.'}</p>
    <div class="meta"><span class="faint">Nom d'utilisateur</span><strong class="mono username">${esc(account.username)}</strong></div>
    <div class="group-list">
      <button class="row-action" id="password"${account.guest ? ' hidden' : ''}><span class="lead"><i class="ph ph-key"></i></span><span><strong>Changer le mot de passe</strong><small>Même si tu as oublié l'ancien</small></span><i class="ph ph-caret-down"></i></button>
      <button class="row-action" id="revoke"${account.guest ? ' hidden' : ''}><span class="lead"><i class="ph ph-prohibit"></i></span><span><strong>Déconnecter les ordinateurs invités</strong><small>Ceux connectés par QR code</small></span><i class="ph ph-caret-down"></i></button>
      <button class="row-action" id="relay"><span class="lead"><i class="ph ph-globe"></i></span><span><strong>Serveur relais</strong><small class="mono">${esc(new URL(relayOrigin()).host)}</small></span><i class="ph ph-caret-down"></i></button>
      <button class="row-action" id="logout"><span class="lead"><i class="ph ph-sign-out"></i></span><span><strong>Se déconnecter</strong><small>De cet appareil</small></span><i class="ph ph-caret-down"></i></button>
    </div>
    <div class="sheet-actions single"><button class="btn btn-quiet" id="cancel">Fermer</button></div>`);
  b.querySelector('#cancel').onclick = closeSheet;
  b.querySelector('#revoke').onclick = async () => {
    await account.revokeGuests();
    b.querySelector('#revoke small').textContent = 'Fait : ils devront rescanner un code';
  };
  b.querySelector('#logout').onclick = async () => {
    account.leaving = true;
    await account.logout().catch(() => {});
    clearToken();
    closeSheet();
    account = null;
    showOnboard();
  };
  b.querySelector('#relay').onclick = relaySheet;
  b.querySelector('#password').onclick = passwordSheet;
};

function passwordSheet() {
  const b = sheet(`<h2>Nouveau mot de passe</h2>
    <p>Ton mot de passe n'est enregistré nulle part en clair, il ne peut donc pas être affiché. Choisis-en un nouveau : les appareils déjà connectés le restent.</p>
    <form id="pw-form" autocomplete="off">
      <label class="field"><span>Nouveau mot de passe</span><input id="pw1" type="password" required minlength="8"></label>
      <label class="field"><span>Confirmer</span><input id="pw2" type="password" required minlength="8"></label>
      <p class="alert" id="serr" role="alert"></p>
      <div class="sheet-actions"><button type="button" class="btn btn-quiet" id="cancel">Annuler</button><button class="btn btn-primary" id="ok">Enregistrer</button></div>
    </form>`);
  b.querySelector('#cancel').onclick = closeSheet;
  b.querySelector('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = b.querySelector('#pw1').value, p2 = b.querySelector('#pw2').value;
    if (p1 !== p2) { b.querySelector('#serr').innerHTML = alertBox('Les deux mots de passe ne sont pas identiques.'); return; }
    b.querySelector('#ok').disabled = true;
    const r = await account.setPassword(p1);
    if (r.t !== 'password-ok') { b.querySelector('#serr').innerHTML = alertBox(reason(r.reason)); b.querySelector('#ok').disabled = false; return; }
    sheet(`<div class="hero-icon"><i class="ph ph-check"></i></div><h2>Mot de passe changé</h2>
      <p>Utilise-le désormais avec le nom d'utilisateur <strong class="mono">${esc(account.username)}</strong>.</p>
      <div class="sheet-actions single"><button class="btn btn-primary" id="done">Terminé</button></div>`).querySelector('#done').onclick = closeSheet;
  };
  b.querySelector('#pw1').focus();
}

function relaySheet() {
  const b = sheet(`<h2>Serveur relais</h2><p>À changer seulement si tu héberges ton propre relais.</p>
    <label class="field"><span>Adresse</span><input id="relay-url" value="${esc(relayOrigin())}" autocapitalize="none" spellcheck="false"></label>
    <p class="alert" id="serr" role="alert"></p>
    <div class="sheet-actions"><button class="btn btn-quiet" id="cancel">Annuler</button><button class="btn btn-primary" id="ok">Enregistrer</button></div>`);
  b.querySelector('#cancel').onclick = closeSheet;
  b.querySelector('#ok').onclick = () => {
    const v = b.querySelector('#relay-url').value.trim().replace(/\/$/, '');
    if (!/^https:\/\/[^/]+$/.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v)) {
      b.querySelector('#serr').innerHTML = alertBox('Adresse attendue : https://ton-relais');
      return;
    }
    localStorage.setItem('relay', v);
    clearToken();
    location.reload();
  };
}

// ---------- Connecter l'ordinateur d'un ami ----------
async function scanQR(hint) {
  const s = T.barcodeScanner;
  let perm = await s.checkPermissions();
  if (perm !== 'granted') perm = await s.requestPermissions();
  if (perm !== 'granted') { showError("Autorise l'appareil photo dans les réglages pour scanner."); return null; }
  const ui = document.createElement('div');
  ui.className = 'scan-ui';
  ui.innerHTML = '<div class="frame"></div><p></p><button class="btn">Annuler</button>';
  ui.querySelector('p').textContent = hint;
  ui.querySelector('button').onclick = () => s.cancel();
  document.body.append(ui);
  document.documentElement.classList.add('scanning');
  try {
    const r = await s.scan({ windowed: true, formats: [s.Format.QRCode] });
    return r && r.content;
  } catch {
    return null;
  } finally {
    ui.remove();
    document.documentElement.classList.remove('scanning');
  }
}

/** Demande le code à usage unique (ou le QR code sur téléphone) de l'appareil à connecter. */
function askTarget() {
  return new Promise((resolve) => {
    const b = sheet(`<h2>Connecter un appareil</h2>
      <p>Saisis le code à usage unique affiché sur l'autre appareil, sous son QR code.</p>
      <form id="code-form" autocomplete="off">
        <label class="field"><span>Code</span><input id="code" class="code-input" required maxlength="9" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="K7P 4QX" inputmode="text"></label>
        <p class="alert" id="cerr" role="alert"></p>
        <div class="sheet-actions"><button type="button" class="btn btn-quiet" id="cancel">Annuler</button><button class="btn btn-primary" id="ok">Continuer</button></div>
        ${mobile ? '<button type="button" class="btn-link" id="scan"><i class="ph ph-scan"></i> Scanner le QR code à la place</button>' : ''}
      </form>`);
    const input = b.querySelector('#code');
    input.oninput = () => {
      const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6);
      input.value = raw.length > 3 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
    };
    b.querySelector('#cancel').onclick = () => { closeSheet(); resolve(null); };
    b.querySelector('#code-form').onsubmit = (e) => {
      e.preventDefault();
      const t = parseTarget(input.value);
      if (!t) { b.querySelector('#cerr').innerHTML = alertBox('Le code fait 6 caractères.'); return; }
      closeSheet();
      resolve(t);
    };
    if (mobile) b.querySelector('#scan').onclick = async () => {
      closeSheet();
      const text = await scanQR("Vise le QR code affiché sur l'autre appareil");
      resolve(text ? parseTarget(text) : null);
    };
    setTimeout(() => input.focus(), 50);
  });
}

$('btn-link').onclick = async () => {
  showError('');
  const target = await askTarget();
  if (!target) return;
  if (target.origin && target.origin !== relayOrigin()) return showError("Ce code vient d'un autre serveur relais que le tien.");
  const ask = target.code ? { code: target.code } : { linkId: target.linkId };
  const peek = await account.peekLink(ask);
  if (!peek.ok) return showError(reason(peek.reason || 'expired'));
  const txt = linkModeText(peek.mode);
  const icon = peek.kind && peek.kind !== 'web' ? kindInfo(peek.kind).icon : deviceIconForUA(peek.ua);
  const b = sheet(`<div class="hero-icon"><i class="ph ph-${icon}"></i></div>
    <h2>${esc(txt.title)}</h2>
    <p>${esc(txt.text)}</p>
    <div class="meta"><strong>${esc(peek.label || describeUA(peek.ua))}</strong><span class="mono faint">${esc(describeUA(peek.ua))}, ${esc(peek.ip || 'adresse inconnue')}</span></div>
    <p class="alert" id="serr" role="alert"></p>
    <div class="sheet-actions"><button class="btn btn-quiet" id="cancel">Refuser</button><button class="btn btn-primary" id="ok"><i class="ph ph-shield-check"></i>${esc(txt.button)}</button></div>`);
  b.querySelector('#cancel').onclick = closeSheet;
  b.querySelector('#ok').onclick = async () => {
    b.querySelector('#ok').disabled = true;
    const r = await account.approveLink(ask);
    if (r.t !== 'link-ok') { b.querySelector('#serr').innerHTML = alertBox(reason(r.reason)); b.querySelector('#ok').disabled = false; return; }
    sheet(`<div class="hero-icon"><i class="ph ph-check"></i></div><h2>${r.mode === 'host' ? 'Appareil ajouté' : 'Appareil connecté'}</h2>
      <p>${r.mode === 'host' ? 'Il apparaît maintenant dans Mes appareils.' : 'Il affiche maintenant tes appareils.'}</p>
      <div class="sheet-actions single"><button class="btn btn-primary" id="done">Terminé</button></div>`).querySelector('#done').onclick = closeSheet;
  };
};

// ---------- Démarrage ----------
await realKind();
const token = getToken();
if (token) open(token);
else showOnboard();
