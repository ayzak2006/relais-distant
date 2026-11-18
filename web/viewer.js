// Ordinateur d'un ami (ou n'importe quel navigateur) : se connecter à son compte par QR code ou
// identifiants, voir ses appareils, en prendre le contrôle.
import { Account, startGuest, signIn, reason, wsUrlFor, localKind, describeUA, formatCode } from './relay.js';
import { renderDevices } from './devices.js';
import { Remote } from './remote.js';

const $ = (id) => document.getElementById(id);
const url = wsUrlFor(location.origin);
let account = null, remote = null, busyId = null, guestLink = null, mode = 'login', leaving = false;
// Temporaire : jeton limité à cet onglet (12 h). Permanent : mémorisé dans ce navigateur.
let linkMode = 'temp', codeTimer = null;
const getToken = () => localStorage.getItem('token') || sessionStorage.getItem('token');
const saveToken = (t, temporary) => { clearToken(); (temporary ? sessionStorage : localStorage).setItem('token', t); };
const clearToken = () => { localStorage.removeItem('token'); sessionStorage.removeItem('token'); };
const caption = () => (linkMode === 'temp'
  ? '<i class="ph ph-clock"></i>Accès de 12 heures, effacé à la fermeture de l’onglet'
  : '<i class="ph ph-lock-key"></i>Ce navigateur restera connecté à ton compte');

const alertBox = (el, msg) => {
  el.innerHTML = msg ? '<i class="ph ph-warning-circle"></i><span></span>' : '';
  if (msg) el.querySelector('span').textContent = msg;
};

// ---------- 1. Connexion ----------
async function showConnect() {
  $('connect').hidden = false;
  $('devices-view').hidden = true;
  document.title = 'Relais Distant';
  if (guestLink) { guestLink.relay.close(); guestLink = null; }
  $('qr').innerHTML = '<div class="skeleton"></div>';
  let g;
  try {
    g = guestLink = await startGuest(url, { mode: linkMode, label: describeUA(navigator.userAgent), kind: localKind() });
  } catch {
    $('qr-state').innerHTML = '<i class="ph ph-wifi-slash"></i>Relais injoignable, nouvel essai…';
    return setTimeout(showConnect, 2000);
  }
  const img = new Image();
  img.alt = 'Code QR de connexion';
  img.onload = () => $('qr').replaceChildren(img);
  img.src = '/qr.svg?d=' + encodeURIComponent(`${location.origin}/p#link=${g.linkId}`);
  $('qr-state').innerHTML = caption();
  $('qr-code').textContent = formatCode(g.code);
  // Le code expire au bout de 10 minutes : on en affiche un nouveau avant.
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => { if (guestLink === g && !$('connect').hidden) showConnect(); }, Math.max(30000, g.expires - Date.now() - 20000));
  g.relay.on('close', () => { if (guestLink === g && !$('connect').hidden && !account) setTimeout(showConnect, 1500); });
  const auth = await g.authorized;
  if (guestLink !== g || auth.t !== 'auth') return;
  guestLink = null;
  g.relay.close();
  saveToken(auth.token, auth.mode === 'temp');
  openAccount(auth.token);
}

document.querySelectorAll('.pc-panel [data-mode]').forEach((b) => {
  b.onclick = () => {
    if (linkMode === b.dataset.mode) return;
    linkMode = b.dataset.mode;
    document.querySelectorAll('.pc-panel [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
    showConnect();
  };
});

$('show-login').onclick = () => {
  $('show-login').hidden = true;
  $('login-form').hidden = false;
  $('username').focus();
};
$('toggle-mode').onclick = () => {
  mode = mode === 'login' ? 'register' : 'login';
  $('login-btn').textContent = mode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('toggle-mode').textContent = mode === 'login' ? 'Pas encore de compte ? En créer un' : 'J’ai déjà un compte';
  alertBox($('error'), '');
};
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  alertBox($('error'), '');
  $('login-btn').disabled = true;
  const r = await signIn(url, { mode, username: $('username').value.trim().toLowerCase(), password: $('password').value, label: describeUA(navigator.userAgent), kind: localKind(), temporary: linkMode === 'temp' });
  $('login-btn').disabled = false;
  if (r.t !== 'auth') return alertBox($('error'), reason(r.reason));
  $('password').value = '';
  saveToken(r.token, linkMode === 'temp');
  if (guestLink) { guestLink.relay.close(); guestLink = null; }
  openAccount(r.token);
};

// ---------- 2. Appareils ----------
async function openAccount(token) {
  account = new Account(url);
  const r = await account.open(token);
  if (r.t !== 'ready') {
    clearToken();
    account = null;
    return showConnect();
  }
  $('connect').hidden = true;
  $('devices-view').hidden = false;
  $('who').textContent = account.username;
  $('avatar').textContent = account.username.slice(0, 1).toUpperCase();
  $('who-sub').textContent = account.guest && account.expires
    ? `Invité jusqu'à ${new Date(account.expires).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : 'Connexion permanente';
  account.onDevices = renderAll;
  account.relay.on('close', () => { if (leaving) return; if (remote) remote.end('Connexion au relais perdue.'); else setTimeout(() => openAccount(token), 1500); });
  account.relay.on('signal', (m) => remote && remote.onSignal(m.data));
  account.relay.on('kicked', (m) => remote && remote.end(m.reason ? reason(m.reason) : 'L’appareil a coupé la session.'));
  account.relay.on('host-left', () => remote && remote.end('L’appareil s’est déconnecté.'));
  account.relay.on('auth-fail', () => { clearToken(); location.reload(); });
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
  alertBox($('dev-error'), '');
  busyId = device.id;
  renderAll();
  const r = await account.connect(device.id);
  busyId = null;
  renderAll();
  if (r.t !== 'ok') return alertBox($('dev-error'), reason(r.reason || r.t));
  $('devices-view').hidden = true;
  remote = new Remote({
    ice: r.ice,
    host: device.name,
    title: `${device.name} · Relais Distant`,
    sendSignal: (data) => account.relay.send({ t: 'signal', data }),
    onEnd: () => account.end(),
    endAction: {
      label: 'Mes appareils',
      icon: 'arrow-left',
      run: () => { remote.destroy(); remote = null; $('devices-view').hidden = false; document.title = 'Relais Distant'; renderAll(); },
    },
  });
}

$('logout').onclick = async () => {
  leaving = true;
  if (account) await account.logout().catch(() => {});
  clearToken();
  location.reload();
};

const saved = getToken();
if (saved) openAccount(saved);
else showConnect();
