// Grille « Mes appareils », partagée par le site et les apps.
import { kindInfo, lastSeen, notControllableReason } from './relay.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {HTMLElement} el
 * @param {{id:string,name:string,kind:string,online:boolean,lastSeen:number}[]} devices
 * @param {{busyId?:string, selfId?:string, onConnect:(d)=>void, onMore?:(d)=>void, empty:string}} opts
 */
export function renderDevices(el, devices, { busyId, selfId, onConnect, onMore, empty }) {
  // Seuls les appareils contrôlables sont affichés (pas cet appareil), ceux en ligne en tête.
  const sorted = devices
    .filter((d) => d.controllable && d.id !== selfId)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!sorted.length) {
    el.innerHTML = `<div class="tile tile-add tile-empty"><i class="ph ph-desktop"></i><strong>Aucun appareil pour l'instant</strong><span>${empty}</span></div>`;
    return;
  }
  el.innerHTML = sorted.map((d, i) => {
    const k = kindInfo(d.kind);
    const busy = busyId === d.id;
    const self = d.id === selfId;
    const can = d.controllable && d.online && !self;
    const status = self ? '<span class="status on">Cet appareil</span>'
      : !d.controllable ? `<span class="status">${esc(notControllableReason(d.kind))}</span>`
      : d.online ? '<span class="status on">En ligne</span>' : `<span class="status">Vu ${esc(lastSeen(d.lastSeen))}</span>`;
    return `<div class="tile${can ? '' : ' off'}${d.controllable ? '' : ' viewer'}${busy ? ' busy' : ''}" role="button" tabindex="${can ? 0 : -1}" aria-disabled="${!can}" data-i="${i}">
      <div class="tile-top">
        <span class="tile-icon"><i class="ph ph-${k.icon}"></i></span>
        ${onMore ? `<button class="icon-btn" data-more="${i}" aria-label="Options de ${esc(d.name)}"><i class="ph ph-dots-three"></i></button>` : ''}
      </div>
      <div>
        <div class="tile-name">${esc(d.name)}</div>
        <span class="faint tile-kind">${esc(k.label)}</span>
      </div>
      <div class="tile-sub">
        ${status}
        ${can ? `<span class="tile-go">${busy ? 'Connexion…' : 'Contrôler<i class="ph ph-arrow-right" aria-hidden="true"></i>'}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.tile[data-i]').forEach((t) => {
    t.style.setProperty('--i', t.dataset.i);
    const d = sorted[Number(t.dataset.i)];
    const go = () => { if (d.controllable && d.online && d.id !== selfId && !busyId) onConnect(d); };
    t.onclick = (e) => { if (!e.target.closest('[data-more]')) go(); };
    t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  if (onMore) el.querySelectorAll('[data-more]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); onMore(sorted[Number(b.dataset.more)]); }));
}

import qrcode from './vendor/qrcode.mjs';

/** QR code en SVG, généré localement (aucune requête réseau). */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
