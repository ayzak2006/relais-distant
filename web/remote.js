// Session à distance : vidéo WebRTC + souris, clavier, gestes tactiles (trackpad), zoom.
// Partagé par le site web et les apps.

const isMacLike = /Mac|iPhone|iPad/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
const hasTouch = navigator.maxTouchPoints > 0;

const html = `
  <video autoplay playsinline muted tabindex="0"></video>
  <textarea class="kbd" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Clavier"></textarea>
  <button class="handle" aria-label="Afficher les outils"></button>
  <nav class="dock" aria-label="Outils de session">
    <span class="stats">Connexion</span>
    <span class="sep"></span>
    <button class="icon-btn" data-a="swap" title="Ctrl de ce clavier = ⌘ sur le Mac"><i class="ph ph-command"></i></button>
    <button class="icon-btn" data-a="kbd" title="Clavier"><i class="ph ph-keyboard"></i></button>
    <button class="icon-btn" data-a="paste" title="Taper le texte du presse-papiers"><i class="ph ph-clipboard-text"></i></button>
    <button class="icon-btn" data-a="spot" title="Spotlight (⌘ Espace)"><i class="ph ph-magnifying-glass-plus"></i></button>
    <button class="icon-btn" data-a="tab" title="Changer d'app (⌘ Tab)"><i class="ph ph-app-window"></i></button>
    <button class="icon-btn" data-a="zoom1" title="Taille réelle" hidden><i class="ph ph-magnifying-glass-minus"></i></button>
    <button class="icon-btn" data-a="full" title="Plein écran"><i class="ph ph-arrows-out"></i></button>
    <span class="sep"></span>
    <button class="icon-btn end" data-a="quit" title="Se déconnecter"><i class="ph ph-sign-out"></i></button>
  </nav>
  <div class="overlay"><div class="overlay-card"><strong class="ov-title">Connexion</strong><p class="ov-text">Ouverture de la liaison avec ton Mac</p><div class="bar"></div></div></div>`;

export class Remote {
  /**
   * @param {{ice: RTCIceServer[], sendSignal: (data) => void, onEnd?: (msg) => void, title?: string}} opts
   */
  constructor({ ice, sendSignal, onEnd, title, host, endAction }) {
    this.sendSignal = sendSignal;
    this.onEnd = onEnd;
    this.endAction = endAction;
    this.connected = true;
    this.root = document.createElement('div');
    this.root.className = 'remote';
    this.root.innerHTML = html;
    document.body.appendChild(this.root);
    if (title) document.title = title;
    const q = (s) => this.root.querySelector(s);
    this.video = q('video');
    this.kbd = q('.kbd');
    this.toolbar = q('.dock');
    this.overlay = q('.overlay');
    this.stats = q('.stats');
    this.swapBtn = q('[data-a=swap]');
    this.swap = { checked: !isMacLike };
    this.swapBtn.classList.toggle('on', this.swap.checked);
    this.zoomBtn = q('[data-a=zoom1]');
    if (host) q('.ov-title').textContent = `Connexion à ${host}`;
    if (!hasTouch) q('[data-a=kbd]').hidden = true;
    if (!document.fullscreenEnabled) q('[data-a=full]').hidden = true;

    this.zoom = { z: 1, tx: 0, ty: 0 };
    this.cursor = { x: 0.5, y: 0.5 };
    this.textKeys = new Set();

    this.pc = new RTCPeerConnection({ iceServers: ice });
    this.pc.ontrack = (e) => {
      try { e.receiver.jitterBufferTarget = 0; } catch {}
      try { e.receiver.playoutDelayHint = 0; } catch {}
      this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    };
    this.pc.ondatachannel = (e) => {
      this.dc = e.channel;
      this.dc.onopen = () => { this.overlay.hidden = true; this.video.focus(); };
      this.dc.onclose = () => this.end('Session terminée.');
    };
    this.pc.onconnectionstatechange = () => {
      this.stats.classList.remove('connected', 'failed', 'disconnected');
      this.stats.classList.add(this.pc.connectionState);
      if (this.pc.connectionState === 'failed') this.end('Connexion directe impossible (réseau trop restrictif : un serveur TURN est nécessaire).');
    };
    this.statTimer = setInterval(() => this.updateStats(), 2000);
    this.bindMouse();
    this.bindTouch();
    this.bindKeyboard();
    this.bindToolbar();
    this.reveal(4000);
  }

  async onSignal(data) {
    if (!data || !data.sdp) return;
    await this.pc.setRemoteDescription(data.sdp);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    // ICE non-trickle : on attend la collecte des candidats (2 s max).
    await new Promise((res) => {
      if (this.pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 2000);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
    this.sendSignal({ sdp: this.pc.localDescription });
  }

  input(m) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(m));
  }

  end(msg) {
    if (!this.connected) return;
    this.connected = false;
    this.input({ k: 'r' });
    clearInterval(this.statTimer);
    try { this.pc.close(); } catch {}
    this.overlay.hidden = false;
    this.root.classList.add('ended');
    const card = this.overlay.querySelector('.overlay-card');
    card.innerHTML = '<i class="ph ph-desktop"></i><strong>Session terminée</strong><p></p>';
    card.querySelector('p').textContent = msg || 'Tu es déconnecté du Mac.';
    if (this.endAction) {
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.innerHTML = `<i class="ph ph-${this.endAction.icon || 'arrow-left'}"></i>`;
      b.append(this.endAction.label);
      b.onclick = () => this.endAction.run();
      card.append(b);
    }
    if (this.onEnd) this.onEnd(msg);
  }

  destroy() {
    this.end('');
    this.root.remove();
  }

  // ---------- Géométrie ----------
  /** Rectangle de l'image affichée (object-fit: contain) à zoom 1, en pixels écran. */
  contentRect() {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const vw = this.video.videoWidth || W, vh = this.video.videoHeight || H;
    const s = Math.min(W / vw, H / vh);
    const w = vw * s, h = vh * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h, W, H };
  }
  /** Point écran -> coordonnées normalisées sur l'écran du Mac (tient compte du zoom). */
  norm(clientX, clientY) {
    const r = this.contentRect();
    const { z, tx, ty } = this.zoom;
    const px = (clientX - tx) / z, py = (clientY - ty) / z;
    return { x: clamp((px - r.x) / r.w), y: clamp((py - r.y) / r.h) };
  }
  applyZoom() {
    const { z, tx, ty } = this.zoom;
    this.video.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
  }
  /** Zoomé : la vue suit le curseur. */
  follow() {
    if (this.zoom.z <= 1) return;
    const r = this.contentRect(), z = this.zoom.z;
    const px = r.x + this.cursor.x * r.w, py = r.y + this.cursor.y * r.h;
    this.zoom.tx = Math.min(0, Math.max(r.W - z * r.W, r.W / 2 - z * px));
    this.zoom.ty = Math.min(0, Math.max(r.H - z * r.H, r.H / 2 - z * py));
    this.applyZoom();
  }

  // ---------- Souris (absolue) ----------
  bindMouse() {
    const v = this.video;
    let pending = null, queued = false;
    const btn = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
    v.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.clientY < 40) this.reveal(1500);
      pending = this.norm(e.clientX, e.clientY);
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (pending) { this.cursor = pending; this.input({ k: 'm', ...pending }); }
        pending = null;
      });
    });
    v.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      v.focus();
      v.setPointerCapture(e.pointerId);
      const p = this.norm(e.clientX, e.clientY);
      this.input({ k: 'm', ...p });
      this.input({ k: 'd', b: btn(e.button), ...p });
      e.preventDefault();
    });
    v.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      this.input({ k: 'u', b: btn(e.button), ...this.norm(e.clientX, e.clientY) });
      e.preventDefault();
    });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    v.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        // Pincement sur trackpad : zoom local.
        this.setZoom(this.zoom.z * Math.exp(-e.deltaY / 100));
      } else {
        const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        this.input({ k: 'w', dx: e.deltaX * f, dy: e.deltaY * f });
      }
      e.preventDefault();
    }, { passive: false });
  }

  setZoom(z) {
    this.zoom.z = Math.min(5, Math.max(1, z));
    this.zoomBtn.hidden = this.zoom.z === 1;
    if (this.zoom.z === 1) { this.zoom.tx = this.zoom.ty = 0; this.applyZoom(); } else this.follow();
  }

  // ---------- Tactile : l'écran sert de trackpad ----------
  // 1 doigt : déplacer · toucher : clic · toucher-maintenir puis glisser : glisser-déposer
  // 2 doigts : toucher = clic droit, glisser = défiler, pincer = zoomer
  bindTouch() {
    const v = this.video;
    const touches = new Map();
    let gesture = null;
    const SPEED = 1.6;

    const send = (k, extra = {}) => this.input({ k, ...this.cursor, ...extra });
    const moveCursor = (dx, dy) => {
      const r = this.contentRect(), z = this.zoom.z;
      this.cursor = { x: clamp(this.cursor.x + (dx * SPEED) / (r.w * z)), y: clamp(this.cursor.y + (dy * SPEED) / (r.h * z)) };
      send('m');
      this.follow();
    };

    v.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      v.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (touches.size === 1) {
        gesture = { kind: 'one', start: performance.now(), moved: false, dragging: false };
        gesture.hold = setTimeout(() => {
          if (gesture && gesture.kind === 'one' && !gesture.moved) {
            gesture.dragging = true;
            send('d', { b: 0 });
            if (navigator.vibrate) navigator.vibrate(15);
          }
        }, 450);
      } else if (touches.size === 2) {
        if (gesture && gesture.hold) clearTimeout(gesture.hold);
        if (gesture && gesture.dragging) send('u', { b: 0 });
        const [a, b] = [...touches.values()];
        gesture = { kind: 'two', start: performance.now(), moved: false, dist: Math.hypot(a.x - b.x, a.y - b.y), cy: (a.y + b.y) / 2, cx: (a.x + b.x) / 2 };
      }
    });

    v.addEventListener('pointermove', (e) => {
      const t = touches.get(e.pointerId);
      if (!t || !gesture) return;
      e.preventDefault();
      const dx = e.clientX - t.x, dy = e.clientY - t.y;
      t.x = e.clientX; t.y = e.clientY;
      if (Math.hypot(t.x - t.x0, t.y - t.y0) > 8) gesture.moved = true;
      if (gesture.kind === 'one') {
        if (gesture.moved && gesture.hold && !gesture.dragging) clearTimeout(gesture.hold);
        moveCursor(dx, dy);
      } else if (gesture.kind === 'two' && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y), cy = (a.y + b.y) / 2, cx = (a.x + b.x) / 2;
        if (Math.abs(dist - gesture.dist) > 2) this.setZoom(this.zoom.z * (dist / gesture.dist));
        else this.input({ k: 'w', dx: (gesture.cx - cx) * 2, dy: (gesture.cy - cy) * 2 });
        gesture.dist = dist; gesture.cy = cy; gesture.cx = cx;
      }
    });

    const up = (e) => {
      if (!touches.has(e.pointerId)) return;
      e.preventDefault();
      touches.delete(e.pointerId);
      if (!gesture) return;
      const quick = performance.now() - gesture.start < 280;
      if (gesture.kind === 'one' && touches.size === 0) {
        clearTimeout(gesture.hold);
        if (gesture.dragging) send('u', { b: 0 });
        else if (!gesture.moved && quick) { send('d', { b: 0 }); send('u', { b: 0 }); }
        gesture = null;
      } else if (gesture.kind === 'two' && touches.size < 2) {
        if (!gesture.moved && quick) { send('d', { b: 1 }); send('u', { b: 1 }); }
        if (touches.size === 0) gesture = null;
        else gesture = { kind: 'rest' }; // un doigt reste posé : on ignore jusqu'au relâchement
      } else if (touches.size === 0) gesture = null;
    };
    v.addEventListener('pointerup', up);
    v.addEventListener('pointercancel', up);
  }

  // ---------- Clavier ----------
  // Caractères envoyés tels quels (indépendant de la disposition du clavier local),
  // raccourcis et touches spéciales par position physique.
  bindKeyboard() {
    const mapCode = (code) => (!this.swap.checked ? code
      : { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight' }[code] || code);
    const active = () => this.connected && (document.activeElement === this.video || document.activeElement === this.kbd);

    window.addEventListener('keydown', (e) => {
      if (!active() || e.isComposing || e.key === 'Unidentified' || e.keyCode === 229) return;
      const altGr = e.getModifierState && e.getModifierState('AltGraph');
      const printable = [...e.key].length === 1 && (altGr || (!e.ctrlKey && !e.metaKey));
      if (printable && document.activeElement === this.kbd) return; // le champ texte s'en charge (beforeinput)
      e.preventDefault();
      if (printable) { this.textKeys.add(e.code); this.input({ k: 't', s: e.key }); return; }
      if (e.key === 'Dead') return;
      this.input({ k: 'kd', c: mapCode(e.code) });
    });
    window.addEventListener('keyup', (e) => {
      if (!active() || e.key === 'Unidentified') return;
      if (this.textKeys.delete(e.code)) { e.preventDefault(); return; }
      const altGr = e.getModifierState && e.getModifierState('AltGraph');
      if ([...e.key].length === 1 && document.activeElement === this.kbd && (altGr || (!e.ctrlKey && !e.metaKey))) return;
      e.preventDefault();
      this.input({ k: 'ku', c: mapCode(e.code) });
    });
    // Clavier virtuel (téléphones, tablettes).
    this.kbd.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertFromPaste') {
        const text = e.data || (e.dataTransfer && e.dataTransfer.getData('text')) || '';
        for (let i = 0; i < text.length; i += 64) this.input({ k: 't', s: text.slice(i, i + 64) });
      } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') this.tap('Enter');
      else if (e.inputType.startsWith('deleteContentBackward') || e.inputType.startsWith('deleteWordBackward')) this.tap('Backspace');
      else if (e.inputType.startsWith('deleteContentForward')) this.tap('Delete');
    });
    window.addEventListener('blur', () => { this.textKeys.clear(); this.input({ k: 'r' }); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.input({ k: 'kf' }); });
  }

  tap(code) {
    this.input({ k: 'kd', c: code });
    this.input({ k: 'ku', c: code });
  }

  combo(...codes) {
    codes.forEach((c) => this.input({ k: 'kd', c }));
    codes.slice().reverse().forEach((c) => this.input({ k: 'ku', c }));
  }

  // ---------- Barre d'outils ----------
  reveal(ms) {
    this.toolbar.classList.add('show');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.toolbar.classList.remove('show'), ms);
  }

  bindToolbar() {
    this.root.querySelector('.handle').onclick = () => {
      if (this.toolbar.classList.contains('show')) this.toolbar.classList.remove('show');
      else this.reveal(6000);
    };
    this.toolbar.addEventListener('click', async (e) => {
      const a = e.target.closest('button') && e.target.closest('button').dataset.a;
      if (!a) return;
      this.reveal(3000);
      if (a === 'kbd') { this.kbd.focus(); return; }
      if (a === 'swap') {
        this.swap.checked = !this.swap.checked;
        this.swapBtn.classList.toggle('on', this.swap.checked);
      }
      if (a === 'spot') this.combo('MetaLeft', 'Space');
      if (a === 'tab') this.combo('MetaLeft', 'Tab');
      if (a === 'zoom1') this.setZoom(1);
      if (a === 'paste') {
        try {
          const text = await navigator.clipboard.readText();
          for (let i = 0; i < text.length; i += 64) this.input({ k: 't', s: text.slice(i, i + 64) });
        } catch { this.stats.textContent = 'Presse-papiers refusé'; }
      }
      if (a === 'full') {
        if (document.fullscreenElement) await document.exitFullscreen();
        else {
          await this.root.requestFullscreen();
          try { await navigator.keyboard.lock(); } catch {}
        }
        const ic = this.root.querySelector('[data-a=full] .ph');
        ic.className = 'ph ' + (document.fullscreenElement ? 'ph-arrows-in' : 'ph-arrows-out');
      }
      if (a === 'quit') { this.end('Déconnecté.'); return; }
      this.video.focus();
    });
    window.addEventListener('resize', () => this.follow());
  }

  async updateStats() {
    if (!this.pc) return;
    const stats = await this.pc.getStats();
    let rtt = null, kbps = 0, fps = 0, res = '';
    const l = (this.last ||= { bytes: 0, frames: 0, ts: 0 });
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) rtt = Math.round(s.currentRoundTripTime * 1000);
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        const dt = (s.timestamp - l.ts) / 1000;
        if (l.ts && dt > 0) { kbps = ((s.bytesReceived - l.bytes) * 8) / dt / 1000; fps = (s.framesDecoded - l.frames) / dt; }
        l.bytes = s.bytesReceived; l.frames = s.framesDecoded; l.ts = s.timestamp;
        if (s.frameWidth) res = `${s.frameWidth}×${s.frameHeight}`;
      }
    });
    const parts = [res, fps ? `${Math.round(fps)} i/s` : '', kbps ? `${(kbps / 1000).toFixed(1)} Mb/s` : '', rtt != null ? `${rtt} ms` : ''].filter(Boolean);
    this.stats.replaceChildren(...(parts.length ? parts : ['Connecté']).map((t) => Object.assign(document.createElement('span'), { textContent: t })));
  }
}

function clamp(v) {
  return Math.min(1, Math.max(0, v));
}
