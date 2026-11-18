// Page téléphone (sans app) : se connecter à son compte, autoriser l'ordinateur d'un ami
// (QR code), et voir ou contrôler ses appareils depuis le navigateur du téléphone.
import { Account, signIn, reason, wsUrlFor, localKind, describeUA, deviceIconForUA, kindInfo, linkModeText, parseTarget } from './relay.js';
import { renderDevices } from './devices.js';
import { Remote } from './remote.js';

const $ = (id) => document.getElementById(id);
const url = wsUrlFor(location.origin);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = (h) => { $('view').hidden = false; $('view').innerHTML = h; };
const alertBox = (msg) => (msg ? `<i class="ph ph-warning-circle"></i><span>${esc(msg)}</span>` : '');
const linkId = new URLSearchParams(location.hash.slice(1)).get('link');
let account = null, remote = null, busyId = null;

// ---------- Connexion au compte ----------
function loginView(intro) {
  let mode = 'login';
  view(`<div class="hero-icon neutral"><i class="ph ph-user"></i></div>
    <h2 id="lt">Se connecter</h2><p>${intro}</p>
    <form id="f" autocomplete="off">
      <label class="field"><span>Nom d'utilisateur</span><input id="u" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>Mot de passe</span><input id="pw" type="password" required minlength="8"></label>
      <p class="alert" id="err" role="alert"></p>
      <button class="btn btn-primary btn-block" id="go">Se connecter</button>
      <button type="button" class="btn-link" id="mode">Pas encore de compte ? En créer un</button>
    </form>`);
  $('mode').onclick = () => {
    mode = mode === 'login' ? 'register' : 'login';
    $('lt').textContent = mode === 'login' ? 'Se connecter' : 'Créer un compte';
    $('go').textContent = mode === 'login' ? 'Se connecter' : 'Créer mon compte';
    $('mode').textContent = mode === 'login' ? 'Pas encore de compte ? En créer un' : 'J’ai déjà un compte';
  };
  $('f').onsubmit = async (e) => {
    e.preventDefault();
    $('go').disabled = true;
    const r = await signIn(url, { mode, username: $('u').value.trim().toLowerCase(), password: $('pw').value, label: describeUA(navigator.userAgent), kind: localKind() });
    $('go').disabled = false;
    if (r.t !== 'auth') { $('err').innerHTML = alertBox(reason(r.reason)); return; }
    localStorage.setItem('token', r.token);
    start();
  };
}

// ---------- Autoriser l'ordinateur d'un ami ----------
async function approveView(target = { linkId }) {
  const peek = await account.peekLink(target);
  if (!peek.ok) {
    history.replaceState(null, '', '/p');
    view(`<div class="hero-icon neutral"><i class="ph ph-clock"></i></div><h2>Code expiré</h2><p>${esc(reason('expired'))}</p>`);
    return homeView(true);
  }
  const txt = linkModeText(peek.mode);
  const icon = peek.kind && peek.kind !== 'web' ? kindInfo(peek.kind).icon : deviceIconForUA(peek.ua);
  view(`<div class="hero-icon"><i class="ph ph-${icon}"></i></div>
    <h2>${esc(txt.title)}</h2>
    <p>${esc(txt.text)}</p>
    <div class="meta"><strong>${esc(peek.label || describeUA(peek.ua))}</strong><span class="mono faint">${esc(describeUA(peek.ua))}, ${esc(peek.ip || 'adresse inconnue')}</span></div>
    <p class="alert" id="err" role="alert"></p>
    <div class="stack">
      <button class="btn btn-primary btn-block" id="ok"><i class="ph ph-shield-check"></i>${esc(txt.button)}</button>
      <button class="btn btn-quiet btn-block" id="no">Refuser</button>
    </div>`);
  $('no').onclick = () => { history.replaceState(null, '', '/p'); homeView(); };
  $('ok').onclick = async () => {
    $('ok').disabled = true;
    const r = await account.approveLink(target);
    history.replaceState(null, '', '/p');
    if (r.t !== 'link-ok') { $('err').innerHTML = alertBox(reason(r.reason)); $('ok').disabled = false; return; }
    view(r.mode === 'host'
      ? `<div class="hero-icon"><i class="ph ph-check"></i></div><h2>Appareil ajouté</h2><p>Il apparaît maintenant dans Mes appareils.</p>`
      : `<div class="hero-icon"><i class="ph ph-check"></i></div><h2>Appareil connecté</h2><p>Choisis l'appareil à contrôler sur son écran. Tu peux ranger ton téléphone.</p>`);
    homeView(true);
  };
}

// ---------- Mes appareils ----------
function homeView(keepCard) {
  if (!keepCard) $('view').hidden = true;
  $('devices').hidden = false;
  $('who').textContent = account.username;
  ['add', 'password', 'revoke'].forEach((id) => { $(id).hidden = !!account.guest; });
  account.onDevices = renderAll;
  renderAll();
}

function renderAll() {
  renderDevices($('tiles'), account.devices, {
    busyId,
    onConnect: control,
    empty: 'Installe Relais Distant Agent sur ton Mac et connecte-le à ce compte.',
  });
}

async function control(device) {
  busyId = device.id;
  renderAll();
  const r = await account.connect(device.id);
  busyId = null;
  renderAll();
  if (r.t !== 'ok') { $('dev-error').innerHTML = alertBox(reason(r.reason || r.t)); return; }
  $('page').hidden = true;
  remote = new Remote({
    ice: r.ice,
    host: device.name,
    title: `${device.name} · Relais Distant`,
    sendSignal: (data) => account.relay.send({ t: 'signal', data }),
    onEnd: () => account.end(),
    endAction: { label: 'Mes appareils', icon: 'arrow-left', run: () => { remote.destroy(); remote = null; $('page').hidden = false; renderAll(); } },
  });
}

$('logout').onclick = async () => {
  await account.logout().catch(() => {});
  localStorage.removeItem('token');
  location.replace('/p');
};
$('add').onclick = () => {
  view(`<div class="hero-icon neutral"><i class="ph ph-plus"></i></div><h2>Connecter un appareil</h2>
    <p>Saisis le code à usage unique affiché sur l'autre appareil, sous son QR code.</p>
    <form id="cf" autocomplete="off">
      <label class="field"><span>Code</span><input id="code" class="code-input" required maxlength="9" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="K7P 4QX"></label>
      <p class="alert" id="err" role="alert"></p>
      <div class="stack"><button class="btn btn-primary btn-block">Continuer</button><button type="button" class="btn btn-quiet btn-block" id="cx">Annuler</button></div>
    </form>`);
  const input = $('code');
  input.oninput = () => { const r = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6); input.value = r.length > 3 ? `${r.slice(0, 3)} ${r.slice(3)}` : r; };
  $('cx').onclick = () => { $('view').hidden = true; };
  $('cf').onsubmit = (e) => {
    e.preventDefault();
    const t = parseTarget(input.value);
    if (!t || !t.code) { $('err').innerHTML = alertBox('Le code fait 6 caractères.'); return; }
    approveView({ code: t.code });
  };
  input.focus();
  window.scrollTo(0, 0);
};
$('password').onclick = () => {
  view(`<div class="hero-icon neutral"><i class="ph ph-key"></i></div><h2>Nouveau mot de passe</h2>
    <p>Ton mot de passe n'est enregistré nulle part en clair, il ne peut donc pas être affiché. Choisis-en un nouveau pour le compte <strong class="mono">${esc(account.username)}</strong>.</p>
    <form id="pf" autocomplete="off">
      <label class="field"><span>Nouveau mot de passe</span><input id="p1" type="password" required minlength="8"></label>
      <label class="field"><span>Confirmer</span><input id="p2" type="password" required minlength="8"></label>
      <p class="alert" id="err" role="alert"></p>
      <div class="stack"><button class="btn btn-primary btn-block" id="ps">Enregistrer</button><button type="button" class="btn btn-quiet btn-block" id="px">Annuler</button></div>
    </form>`);
  $('px').onclick = () => { $('view').hidden = true; };
  $('pf').onsubmit = async (e) => {
    e.preventDefault();
    if ($('p1').value !== $('p2').value) { $('err').innerHTML = alertBox('Les deux mots de passe ne sont pas identiques.'); return; }
    $('ps').disabled = true;
    const r = await account.setPassword($('p1').value);
    if (r.t !== 'password-ok') { $('err').innerHTML = alertBox(reason(r.reason)); $('ps').disabled = false; return; }
    view(`<div class="hero-icon"><i class="ph ph-check"></i></div><h2>Mot de passe changé</h2><p>Utilise-le désormais avec le nom d'utilisateur <strong class="mono">${esc(account.username)}</strong>.</p>`);
  };
  window.scrollTo(0, 0);
};
$('revoke').onclick = async () => {
  $('revoke').disabled = true;
  await account.revokeGuests();
  $('revoke').innerHTML = '<i class="ph ph-check"></i>Ordinateurs invités déconnectés';
};

async function start() {
  const token = localStorage.getItem('token');
  if (!token) return loginView(linkId ? 'Connecte-toi pour autoriser cet ordinateur.' : 'Connecte-toi pour voir et contrôler tes appareils.');
  account = new Account(url);
  const r = await account.open(token);
  if (r.t !== 'ready') {
    localStorage.removeItem('token');
    return loginView('Ta session a expiré, reconnecte-toi.');
  }
  account.relay.on('signal', (m) => remote && remote.onSignal(m.data));
  account.relay.on('kicked', (m) => remote && remote.end(m.reason ? reason(m.reason) : 'L’appareil a coupé la session.'));
  account.relay.on('host-left', () => remote && remote.end('L’appareil s’est déconnecté.'));
  if (linkId) approveView();
  else homeView();
}

start();

// Un nouveau code scanné alors que la page est ouverte : on repart de zéro.
window.addEventListener('hashchange', () => location.reload());
