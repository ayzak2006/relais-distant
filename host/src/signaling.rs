//! Connexion permanente au relais : compte, présence de l'appareil, sessions entrantes.

use crate::capture::CaptureParams;
use crate::config::{random_b64, Config};
use crate::session::{self, IceServer};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// État partagé entre l'interface (barre des menus) et le moteur.
pub struct Shared {
    pub cfg: Mutex<Config>,
    pub cmd: mpsc::UnboundedSender<Command>,
}

pub enum Command {
    /// Couper la session en cours.
    Kick,
    /// Se reconnecter (serveur ou nom changé).
    Reconnect,
    /// Se connecter à un compte (ou le créer).
    Login { username: String, password: String, register: bool },
    /// Se connecter en scannant un QR code avec un appareil déjà connecté.
    LinkStart,
    Logout,
}

/// Notifications vers l'interface.
#[derive(Debug, Clone)]
pub enum UiEvent {
    /// L'appareil est en ligne dans le compte.
    Online(bool),
    Account(Option<String>),
    Session(Option<String>),
    Notify(String, String),
    /// Afficher le QR code de connexion (lien à scanner).
    ShowLink(String, String),
}

struct Active {
    sid: String,
    signals: mpsc::UnboundedSender<Value>,
    cancel: Option<oneshot::Sender<()>>,
}

pub async fn run(shared: Arc<Shared>, mut cmd_rx: mpsc::UnboundedReceiver<Command>, ui: impl Fn(UiEvent) + Send + Sync + 'static) {
    let ui: Arc<dyn Fn(UiEvent) + Send + Sync> = Arc::new(ui);
    let mut backoff = 1u64;
    loop {
        let server = shared.cfg.lock().unwrap().server.clone();
        let url = format!("{}/ws", server.trim_end_matches('/'));
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                backoff = 1;
                let (mut sink, mut stream) = ws.split();
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
                let writer = tokio::spawn(async move {
                    while let Some(s) = out_rx.recv().await {
                        if sink.send(Message::Text(s.into())).await.is_err() {
                            break;
                        }
                    }
                });
                let mut core = Core { shared: shared.clone(), out: out_tx.clone(), ice: vec![], active: None, ui: ui.clone() };
                core.hello();
                let (done_tx, mut done_rx) = mpsc::unbounded_channel::<String>();
                let mut ping = tokio::time::interval(Duration::from_secs(25));
                let reconnect = loop {
                    tokio::select! {
                        msg = stream.next() => match msg {
                            Some(Ok(Message::Text(t))) => {
                                if let Ok(v) = serde_json::from_str::<Value>(&t) { core.handle(v, &done_tx); }
                            }
                            Some(Ok(_)) => {}
                            _ => break false,
                        },
                        Some(cmd) = cmd_rx.recv() => match cmd {
                            Command::Kick => core.end_active(),
                            Command::Reconnect => break true,
                            Command::Login { username, password, register } => {
                                let name = core.shared.cfg.lock().unwrap().name.clone();
                                core.send(json!({ "t": if register { "register" } else { "login" }, "host": true,
                                    "username": username, "password": password, "label": name, "kind": "mac" }));
                            }
                            Command::LinkStart => {
                                let name = core.shared.cfg.lock().unwrap().name.clone();
                                core.send(json!({ "t": "guest-hello", "mode": "host", "label": name, "kind": "mac" }));
                            }
                            Command::Logout => {
                                core.end_active();
                                core.send(json!({ "t": "logout" }));
                                core.forget_account();
                            }
                        },
                        Some(sid) = done_rx.recv() => {
                            if core.active.as_ref().is_some_and(|a| a.sid == sid) {
                                core.active = None;
                                core.send(json!({ "t": "kick", "sid": sid }));
                                (core.ui)(UiEvent::Session(None));
                            }
                        }
                        _ = ping.tick() => { let _ = out_tx.send("ping".to_string()); }
                    }
                };
                core.end_active();
                writer.abort();
                ui(UiEvent::Online(false));
                if reconnect {
                    continue;
                }
            }
            Err(_) => ui(UiEvent::Online(false)),
        }
        let wait = tokio::time::sleep(Duration::from_secs(backoff));
        tokio::pin!(wait);
        tokio::select! {
            _ = &mut wait => {}
            Some(cmd) = cmd_rx.recv() => {
                // Hors ligne : on applique la déconnexion localement, le reste attendra le relais.
                if let Command::Logout = cmd {
                    let mut c = shared.cfg.lock().unwrap();
                    c.token = None;
                    c.username = None;
                    let _ = c.save();
                    ui(UiEvent::Account(None));
                }
                backoff = 1;
                continue;
            }
        }
        backoff = (backoff * 2).min(30);
    }
}

struct Core {
    shared: Arc<Shared>,
    out: mpsc::UnboundedSender<String>,
    ice: Vec<IceServer>,
    active: Option<Active>,
    ui: Arc<dyn Fn(UiEvent) + Send + Sync>,
}

impl Core {
    fn send(&self, v: Value) {
        let _ = self.out.send(v.to_string());
    }

    /// Annonce l'appareil au relais si un compte est connecté.
    fn hello(&self) {
        let c = self.shared.cfg.lock().unwrap();
        match &c.token {
            Some(token) => self.send(json!({ "t": "host-hello", "token": token, "deviceId": c.device_id, "name": c.name, "kind": "mac" })),
            None => (self.ui)(UiEvent::Account(None)),
        }
    }

    fn forget_account(&self) {
        let mut c = self.shared.cfg.lock().unwrap();
        c.token = None;
        c.username = None;
        let _ = c.save();
        (self.ui)(UiEvent::Account(None));
        (self.ui)(UiEvent::Online(false));
    }

    fn end_active(&mut self) {
        if let Some(mut a) = self.active.take() {
            if let Some(c) = a.cancel.take() {
                let _ = c.send(());
            }
            self.send(json!({ "t": "kick", "sid": a.sid }));
            (self.ui)(UiEvent::Session(None));
        }
    }

    fn handle(&mut self, v: Value, done: &mpsc::UnboundedSender<String>) {
        let t = v["t"].as_str().unwrap_or_default();
        let sid = v["sid"].as_str().unwrap_or_default().to_string();
        match t {
            "auth" => {
                {
                    let mut c = self.shared.cfg.lock().unwrap();
                    c.token = v["token"].as_str().map(String::from);
                    c.username = v["username"].as_str().map(String::from);
                    let _ = c.save();
                }
                self.hello();
            }
            "link" => {
                let server = self.shared.cfg.lock().unwrap().server.clone();
                let origin = server.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
                let link = format!("{}/p#link={}", origin.trim_end_matches('/'), v["linkId"].as_str().unwrap_or_default());
                (self.ui)(UiEvent::ShowLink(link, v["code"].as_str().unwrap_or_default().to_string()));
            }
            "auth-fail" => {
                let msg = match v["reason"].as_str() {
                    Some("bad-credentials") => "Nom d'utilisateur ou mot de passe incorrect.",
                    Some("taken") => "Ce nom d'utilisateur est déjà pris.",
                    Some("bad-username") => "Nom d'utilisateur : 3 à 32 caractères (minuscules, chiffres, point, tiret).",
                    Some("short-password") => "Le mot de passe doit faire au moins 8 caractères.",
                    Some("rate") => "Trop de tentatives : patiente une minute.",
                    _ => "Connexion au compte impossible.",
                };
                (self.ui)(UiEvent::Notify("Compte".into(), msg.into()));
            }
            "welcome" => {
                if let Ok(ice) = serde_json::from_value(v["ice"].clone()) {
                    self.ice = ice;
                }
                (self.ui)(UiEvent::Account(v["username"].as_str().map(String::from)));
                (self.ui)(UiEvent::Online(true));
            }
            "error" => match v["reason"].as_str() {
                Some("token") => {
                    self.forget_account();
                    (self.ui)(UiEvent::Notify("Compte".into(), "Session expirée ou appareil retiré : reconnecte-toi.".into()));
                }
                Some("device-owned") => {
                    // Cet identifiant appartient à un autre compte : on en prend un neuf.
                    {
                        let mut c = self.shared.cfg.lock().unwrap();
                        c.device_id = random_b64(16);
                        let _ = c.save();
                    }
                    self.hello();
                }
                _ => {}
            },
            "incoming" => {
                if self.active.is_some() {
                    return self.send(json!({ "t": "refuse", "sid": sid, "reason": "busy" }));
                }
                // Sans l'autorisation d'enregistrer l'écran, la capture échouerait : on le dit clairement.
                if !unsafe { crate::ffi::CGPreflightScreenCaptureAccess() } {
                    self.send(json!({ "t": "refuse", "sid": sid, "reason": "no-permission" }));
                    (self.ui)(UiEvent::Notify(
                        "Autorisation nécessaire".into(),
                        "Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran : active Relais Distant Agent, puis relance-le.".into(),
                    ));
                    return;
                }
                let label = v["from"]["label"].as_str().unwrap_or("Appareil").to_string();
                let guest = v["from"]["guest"].as_bool().unwrap_or(false);
                self.send(json!({ "t": "accept", "sid": sid }));
                let desc = if guest { format!("{label}, invité") } else { label };
                (self.ui)(UiEvent::Session(Some(desc.clone())));
                (self.ui)(UiEvent::Notify("Connexion à distance".into(), format!("Ton Mac est contrôlé depuis {desc}.")));

                let (sig_tx, sig_rx) = mpsc::unbounded_channel();
                let (cancel_tx, cancel_rx) = oneshot::channel();
                self.active = Some(Active { sid: sid.clone(), signals: sig_tx, cancel: Some(cancel_tx) });
                let params = {
                    let c = self.shared.cfg.lock().unwrap();
                    CaptureParams { max_width: c.max_width, fps: c.fps, bitrate: c.bitrate }
                };
                let (ice, out, done, ui) = (self.ice.clone(), self.out.clone(), done.clone(), self.ui.clone());
                tokio::spawn(async move {
                    if let Err(e) = session::run(sid.clone(), ice, params, out.clone(), sig_rx, cancel_rx).await {
                        let _ = out.send(json!({ "t": "kick", "sid": sid, "reason": "capture" }).to_string());
                        ui(UiEvent::Notify("Relais Distant".into(), format!("Session interrompue : {e}")));
                    }
                    let _ = done.send(sid);
                });
            }
            "signal" => {
                if let Some(a) = &self.active {
                    if a.sid == sid {
                        let _ = a.signals.send(v["data"].clone());
                    }
                }
            }
            "peer-left" => {
                if self.active.as_ref().is_some_and(|a| a.sid == sid) {
                    self.end_active();
                }
            }
            _ => {}
        }
    }
}
