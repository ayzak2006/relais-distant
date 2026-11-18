//! Relais Distant Agent : rend ce Mac contrôlable depuis tes autres appareils (barre des menus).
//! Capture ScreenCaptureKit, H.264 matériel et WebRTC, en Rust natif.

mod capture;
mod config;
mod ffi;
mod input;
mod session;
mod signaling;
mod ui;

use config::Config;
use signaling::{Command, Shared, UiEvent};
use std::sync::{Arc, Mutex};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder};

enum UserEvent {
    Ui(UiEvent),
    Menu(MenuEvent),
}

struct Items {
    status: MenuItem,
    account: MenuItem,
    session: MenuItem,
    kick: MenuItem,
    login: MenuItem,
    login_qr: MenuItem,
    register: MenuItem,
    rename: MenuItem,
    server: MenuItem,
    startup: CheckMenuItem,
    perms: MenuItem,
    quit: MenuItem,
}

fn main() {
    let cfg = Config::load();
    if cfg.keep_awake {
        ui::keep_awake();
    }

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(Shared { cfg: Mutex::new(cfg), cmd: cmd_tx });

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = Mutex::new(event_loop.create_proxy());
    let menu_proxy = Mutex::new(event_loop.create_proxy());
    MenuEvent::set_event_handler(Some(move |e| {
        let _ = menu_proxy.lock().unwrap().send_event(UserEvent::Menu(e));
    }));

    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
            rt.block_on(signaling::run(shared, cmd_rx, move |ev| {
                let _ = proxy.lock().unwrap().send_event(UserEvent::Ui(ev));
            }));
        });
    }

    // L'app Relais Distant de ce Mac peut connecter l'agent au compte en écrivant sa configuration :
    // on la surveille et on se reconnecte quand le compte change.
    {
        let shared = shared.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Ok(bytes) = std::fs::read(Config::path()) else { continue };
            let Ok(disk) = serde_json::from_slice::<Config>(&bytes) else { continue };
            let changed = {
                let mut c = shared.cfg.lock().unwrap();
                let changed = c.token != disk.token || c.server != disk.server || c.name != disk.name;
                if changed {
                    c.token = disk.token.clone();
                    c.username = disk.username.clone();
                    c.server = disk.server.clone();
                    c.name = disk.name.clone();
                    c.device_id = disk.device_id.clone();
                }
                changed
            };
            if changed {
                let _ = shared.cmd.send(Command::Reconnect);
            }
        });
    }

    let mut tray: Option<TrayIcon> = None;
    let mut items: Option<Items> = None;
    let mut logged_in = shared.cfg.lock().unwrap().token.is_some();

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                let (menu, it) = build_menu();
                tray = TrayIconBuilder::new()
                    .with_menu(Box::new(menu))
                    .with_icon_templated(ui::tray_icon())
                    .with_tooltip("Relais Distant Agent")
                    .build()
                    .ok();
                set_account(&it, shared.cfg.lock().unwrap().username.clone().filter(|_| logged_in));
                items = Some(it);
                // Demande les autorisations dès le lancement, pas au moment d'une connexion.
                ui::check_permissions(true);
                if !logged_in {
                    ui::notify("Relais Distant", "Connecte ce Mac à ton compte : icône de la barre des menus, puis Se connecter avec un code.");
                }
            }
            Event::UserEvent(UserEvent::Ui(ev)) => {
                let Some(it) = &items else { return };
                match ev {
                    UiEvent::Online(true) => {
                        let name = shared.cfg.lock().unwrap().name.clone();
                        it.status.set_text(format!("● En ligne : {name}"));
                    }
                    UiEvent::Online(false) => {
                        it.status.set_text(if logged_in { "○ Hors ligne (reconnexion…)" } else { "○ Non connecté à un compte" })
                    }
                    UiEvent::Account(user) => {
                        logged_in = user.is_some();
                        set_account(it, user);
                    }
                    UiEvent::Session(Some(desc)) => {
                        it.session.set_text(format!("Contrôlé depuis {desc}"));
                        it.kick.set_enabled(true);
                    }
                    UiEvent::Session(None) => {
                        it.session.set_text("Aucune session");
                        it.kick.set_enabled(false);
                    }
                    UiEvent::Notify(title, body) => ui::notify(&title, &body),
                    UiEvent::ShowLink(link, code) => {
                        let name = shared.cfg.lock().unwrap().name.clone();
                        ui::show_qr(&link, &code, &name);
                    }
                }
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(it.status.text()));
                }
            }
            Event::UserEvent(UserEvent::Menu(e)) => {
                let Some(it) = &items else { return };
                let id = e.id();
                if id == it.kick.id() {
                    let _ = shared.cmd.send(Command::Kick);
                } else if id == it.login.id() {
                    if logged_in {
                        let _ = shared.cmd.send(Command::Logout);
                    } else {
                        ask_credentials(shared.clone(), false);
                    }
                } else if id == it.login_qr.id() {
                    let _ = shared.cmd.send(Command::LinkStart);
                } else if id == it.register.id() {
                    ask_credentials(shared.clone(), true);
                } else if id == it.rename.id() {
                    let s = shared.clone();
                    let cur = s.cfg.lock().unwrap().name.clone();
                    std::thread::spawn(move || {
                        if let Some(n) = ui::ask("Nom de ce Mac dans « Mes appareils » :", &cur, false) {
                            let n: String = n.trim().chars().take(40).collect();
                            if n.is_empty() {
                                return;
                            }
                            let mut c = s.cfg.lock().unwrap();
                            c.name = n;
                            let _ = c.save();
                            drop(c);
                            let _ = s.cmd.send(Command::Reconnect);
                        }
                    });
                } else if id == it.server.id() {
                    let s = shared.clone();
                    let cur = s.cfg.lock().unwrap().server.clone();
                    std::thread::spawn(move || {
                        if let Some(url) = ui::ask("Adresse du serveur relais (wss://…) :", &cur, false) {
                            let url = url.trim().trim_end_matches('/').to_string();
                            if url.starts_with("wss://") || url.starts_with("ws://") {
                                let mut c = s.cfg.lock().unwrap();
                                c.server = url;
                                let _ = c.save();
                                drop(c);
                                let _ = s.cmd.send(Command::Reconnect);
                            } else {
                                ui::notify("Adresse invalide", "Elle doit commencer par wss:// (ou ws:// en local).");
                            }
                        }
                    });
                } else if id == it.startup.id() {
                    ui::set_launch_at_login(it.startup.is_checked());
                } else if id == it.perms.id() {
                    ui::check_permissions(true);
                } else if id == it.quit.id() {
                    let _ = shared.cmd.send(Command::Kick);
                    *flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

/// Demande identifiant puis mot de passe (dialogues natifs) et envoie la connexion au moteur.
fn ask_credentials(shared: Arc<Shared>, register: bool) {
    std::thread::spawn(move || {
        let title = if register { "Choisis un nom d'utilisateur pour ton compte :" } else { "Nom d'utilisateur de ton compte Relais Distant :" };
        let Some(user) = ui::ask(title, "", false) else { return };
        let user = user.trim().to_lowercase();
        if !config::valid_username(&user) {
            ui::notify("Nom invalide", "3 à 32 caractères : minuscules, chiffres, point, tiret.");
            return;
        }
        let prompt = if register { "Choisis un mot de passe (8 caractères minimum) :" } else { "Mot de passe :" };
        let Some(password) = ui::ask(prompt, "", true) else { return };
        if password.chars().count() < 8 {
            ui::notify("Mot de passe", "8 caractères minimum.");
            return;
        }
        let _ = shared.cmd.send(Command::Login { username: user, password, register });
    });
}

fn set_account(it: &Items, user: Option<String>) {
    match user {
        Some(u) => {
            it.account.set_text(format!("Compte : {u}"));
            it.login.set_text("Se déconnecter du compte");
            it.register.set_enabled(false);
            it.login_qr.set_enabled(false);
        }
        None => {
            it.account.set_text("Aucun compte connecté");
            it.login.set_text("Se connecter avec mon identifiant…");
            it.register.set_enabled(true);
            it.login_qr.set_enabled(true);
            it.status.set_text("○ Non connecté à un compte");
        }
    }
}

fn build_menu() -> (Menu, Items) {
    let it = Items {
        status: MenuItem::new("○ Connexion au relais…", false, None),
        account: MenuItem::new("Aucun compte connecté", false, None),
        session: MenuItem::new("Aucune session", false, None),
        kick: MenuItem::new("Couper la session", false, None),
        login: MenuItem::new("Se connecter avec mon identifiant…", true, None),
        login_qr: MenuItem::new("Se connecter avec un code…", true, None),
        register: MenuItem::new("Créer un compte…", true, None),
        rename: MenuItem::new("Nom de ce Mac…", true, None),
        server: MenuItem::new("Serveur relais…", true, None),
        startup: CheckMenuItem::new("Lancer à l'ouverture de session", true, ui::launch_at_login_enabled(), None),
        perms: MenuItem::new("Vérifier les autorisations…", true, None),
        quit: MenuItem::new("Quitter", true, None),
    };
    let menu = Menu::new();
    let sep = PredefinedMenuItem::separator;
    let _ = menu.append_items(&[
        &it.status, &it.account, &it.session, &it.kick, &sep(),
        &it.login_qr, &it.login, &it.register, &it.rename, &it.server, &sep(),
        &it.startup, &it.perms, &sep(), &it.quit,
    ]);
    (menu, it)
}
