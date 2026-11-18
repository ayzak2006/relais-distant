//! Petites briques d'interface natives : dialogues, notifications, autorisations macOS,
//! lancement à l'ouverture de session.

use crate::ffi::*;
use std::process::Command;

/// Échappe une chaîne pour AppleScript.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn notify(title: &str, body: &str) {
    let script = format!("display notification \"{}\" with title \"{}\"", esc(body), esc(title));
    let _ = Command::new("osascript").args(["-e", &script]).spawn();
}

/// Boîte de dialogue texte. `None` si annulée.
pub fn ask(prompt: &str, default: &str, hidden: bool) -> Option<String> {
    let script = format!(
        "text returned of (display dialog \"{}\" default answer \"{}\"{} with title \"Relais Distant\" buttons {{\"Annuler\", \"OK\"}} default button \"OK\")",
        esc(prompt),
        esc(default),
        if hidden { " with hidden answer" } else { "" }
    );
    let out = Command::new("osascript").args(["-e", &script]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}

/// Empêche la mise en veille système tant que l'app tourne (l'écran peut s'éteindre).
pub fn keep_awake() {
    let pid = std::process::id().to_string();
    let _ = Command::new("caffeinate").args(["-i", "-w", &pid]).spawn();
}

/// Affiche le QR code de connexion du Mac dans le navigateur par défaut.
pub fn show_qr(link: &str, code: &str, name: &str) {
    let svg = match qrcode::QrCode::new(link.as_bytes()) {
        Ok(q) => q.render::<qrcode::render::svg::Color<'_>>().min_dimensions(320, 320).quiet_zone(true).build(),
        Err(_) => return,
    };
    let attr = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;");
    let name_html = attr(name);
    let code_html = if code.len() == 6 { format!("{} {}", &code[..3], &code[3..]) } else { attr(code) };
    let html = format!(
        r#"<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecter ce Mac</title>
<style>
:root{{--bg:#f3f4f2;--surface:#fbfbfa;--s2:#eaebe8;--line:rgba(17,19,22,.09);--text:#121416;--t2:#565b62;--accent:#137a45;--on:#f6fff9}}
@media(prefers-color-scheme:dark){{:root{{--bg:#0b0c0d;--surface:#141517;--s2:#1d1f22;--line:rgba(255,255,255,.075);--text:#eceeef;--t2:#a3a8ae;--accent:#3ddc84;--on:#04140b}}}}
*{{box-sizing:border-box}}body{{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}}
main{{width:min(100%,420px);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 12px 32px -12px rgba(0,0,0,.18);animation:r .5s cubic-bezier(.16,1,.3,1) both}}
@keyframes r{{from{{opacity:0;transform:translateY(10px)}}}}
h1{{font-size:22px;letter-spacing:-.022em;margin:0 0 6px;font-weight:620}}p{{color:var(--t2);margin:0 0 20px}}
.qr{{background:#fff;border-radius:16px;padding:6px;aspect-ratio:1}}.qr svg{{width:100%;height:100%;display:block}}
.code{{display:grid;justify-items:center;gap:4px;padding:16px;margin-bottom:16px;border-radius:16px;background:var(--s2)}}
.code span{{color:var(--t2);font-size:13px}}.code strong{{font:600 36px/1.1 ui-monospace,Menlo,monospace;letter-spacing:.08em}}
.qr{{max-width:230px;margin:0 auto}}
small{{display:block;color:var(--t2);font-size:13px;margin-top:10px}}
</style>
<main><h1>Ajouter « {name_html} » à ton compte</h1><p>Sur ton iPhone ou un autre appareil connecté : app Relais Distant, puis Connecter un appareil. Saisis ce code ou scanne le QR code.</p>
<div class="code"><span>Code à usage unique</span><strong>{code_html}</strong></div>
<div class="qr">{svg}</div>
<small>Valable 10 minutes. Pour un nouveau code, choisis à nouveau Se connecter avec un code dans le menu de l'agent.</small></main></html>"#
    );
    let path = std::env::temp_dir().join("relais-distant-connexion.html");
    if std::fs::write(&path, html).is_ok() {
        let _ = Command::new("open").arg(&path).spawn();
    }
}

/// Vérifie (et demande si `prompt`) l'enregistrement d'écran et l'accessibilité.
pub fn check_permissions(prompt: bool) {
    unsafe {
        let screen = CGPreflightScreenCaptureAccess();
        if !screen && prompt {
            CGRequestScreenCaptureAccess();
        }
        let opts = cf_dict(&[(kAXTrustedCheckOptionPrompt, if prompt { kCFBooleanTrue } else { kCFBooleanFalse })]);
        let ax = AXIsProcessTrustedWithOptions(opts);
        CFRelease(opts);
        if !screen || !ax {
            let mut missing = vec![];
            if !screen {
                missing.push("Enregistrement de l'écran");
            }
            if !ax {
                missing.push("Accessibilité");
            }
            notify("Autorisations nécessaires", &format!("Réglages système › Confidentialité : {}", missing.join(" + ")));
        }
    }
}

fn launch_agent_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/LaunchAgents/com.relaisdistant.host.plist")
}

pub fn launch_at_login_enabled() -> bool {
    launch_agent_path().exists()
}

pub fn set_launch_at_login(on: bool) {
    let path = launch_agent_path();
    if !on {
        let _ = std::fs::remove_file(path);
        return;
    }
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.relaisdistant.host</string>
<key>ProgramArguments</key><array><string>{}</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>"#,
        exe.replace('&', "&amp;").replace('<', "&lt;")
    );
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, plist);
}

/// Icône « écran » 36×36 dessinée en code (mode template : seule l'opacité compte).
pub fn tray_icon() -> tray_icon::Icon {
    const S: usize = 36;
    let mut px = vec![0u8; S * S * 4];
    let mut fill = |x0: usize, y0: usize, x1: usize, y1: usize| {
        for y in y0..y1 {
            for x in x0..x1 {
                let i = (y * S + x) * 4;
                px[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    };
    // Cadre de l'écran
    fill(3, 6, 33, 9);
    fill(3, 24, 33, 27);
    fill(3, 6, 6, 27);
    fill(30, 6, 33, 27);
    // Flèche de connexion au centre
    fill(12, 15, 22, 18);
    fill(19, 12, 22, 21);
    // Pied
    fill(16, 27, 20, 30);
    fill(10, 30, 26, 32);
    tray_icon::Icon::from_rgba(px, S as u32, S as u32).expect("icône")
}
