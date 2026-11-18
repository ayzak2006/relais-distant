//! Relais Distant : app cliente (iPhone, iPad, Android, Windows, Mac, Linux).
//! L'interface est web (WebRTC du système). Sur Mac, l'app relie aussi l'agent local
//! (Relais Distant Agent) au même compte, pour que ce Mac soit contrôlable sans autre réglage.

#[cfg(target_os = "macos")]
mod agent {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    use rand::RngCore;
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn config_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library/Application Support/RelaisDistant/config2.json")
    }

    fn read() -> Option<Value> {
        serde_json::from_slice(&std::fs::read(config_path()).ok()?).ok()
    }

    fn computer_name() -> String {
        std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Mon Mac".into())
    }

    /// Identité de ce Mac partagée avec l'agent (créée si besoin), pour n'apparaître qu'une fois.
    #[tauri::command]
    pub fn this_mac() -> Value {
        let cfg = read().unwrap_or(Value::Null);
        let id = cfg["device_id"].as_str().map(String::from).unwrap_or_else(|| {
            let mut b = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut b);
            B64.encode(b)
        });
        let name = cfg["name"].as_str().map(String::from).unwrap_or_else(computer_name);
        let linked = cfg["token"].is_string();
        json!({ "id": id, "name": name, "agentLinked": linked, "agentUser": cfg["username"] })
    }

    /// Connecte l'agent de ce Mac au compte (jeton d'appareil) et le lance.
    #[tauri::command]
    pub fn link_agent(token: String, server: String, username: String, device_id: String, name: String) -> Result<bool, String> {
        let mut cfg = read().unwrap_or_else(|| json!({}));
        cfg["server"] = json!(server);
        cfg["device_id"] = json!(cfg["device_id"].as_str().map(String::from).unwrap_or(device_id));
        cfg["name"] = json!(cfg["name"].as_str().map(String::from).unwrap_or(name));
        cfg["token"] = json!(token);
        cfg["username"] = json!(username);
        let path = config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        // L'agent surveille sa configuration ; s'il ne tourne pas, on le lance.
        let started = std::process::Command::new("open").args(["-g", "-b", "com.relaisdistant.host"]).status().map(|s| s.success()).unwrap_or(false);
        Ok(started)
    }
}

/// Modèle matériel réel (« iPhone16,1 », « iPad8,11 »…) : plus fiable que le navigateur intégré,
/// qui peut se présenter comme un ordinateur sur iPad comme sur iPhone.
#[tauri::command]
fn device_model() -> String {
    #[cfg(unix)]
    unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut u) == 0 {
            return std::ffi::CStr::from_ptr(u.machine.as_ptr()).to_string_lossy().into_owned();
        }
    }
    String::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![device_model, agent::this_mac, agent::link_agent]);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![device_model]);
    builder
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Relais Distant");
}
