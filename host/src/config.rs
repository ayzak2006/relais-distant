//! Configuration locale de l'agent : relais, identité de l'appareil, jeton du compte.

use anyhow::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_SERVER: &str = "wss://relais-distant.relais-distant-worker.workers.dev";

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub server: String,
    /// Identifiant stable de cet appareil dans le compte.
    pub device_id: String,
    /// Nom affiché dans « Mes appareils ».
    pub name: String,
    /// Jeton du compte (jamais le mot de passe).
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default = "d_width")]
    pub max_width: u32,
    #[serde(default = "d_fps")]
    pub fps: u32,
    #[serde(default = "d_bitrate")]
    pub bitrate: i32,
    #[serde(default = "d_true")]
    pub keep_awake: bool,
}
fn d_width() -> u32 { 1920 }
fn d_fps() -> u32 { 60 }
fn d_bitrate() -> i32 { 12_000_000 }
fn d_true() -> bool { true }

pub fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b)
}

fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/RelaisDistant")
}

fn computer_name() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().chars().take(40).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mon Mac".into())
}

impl Config {
    pub fn path() -> PathBuf {
        dir().join("config2.json")
    }

    pub fn load() -> Self {
        if let Ok(s) = std::fs::read_to_string(Self::path()) {
            if let Ok(c) = serde_json::from_str(&s) {
                return c;
            }
        }
        let c = Config {
            server: std::env::var("RELAIS_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.into()),
            device_id: random_b64(16),
            name: computer_name(),
            token: None,
            username: None,
            max_width: d_width(),
            fps: d_fps(),
            bitrate: d_bitrate(),
            keep_awake: true,
        };
        let _ = c.save();
        c
    }

    pub fn save(&self) -> Result<()> {
        std::fs::create_dir_all(dir())?;
        let p = Self::path();
        std::fs::write(&p, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

/// Nom d'utilisateur valide : minuscules, chiffres, point, tiret, souligné (3 à 32).
pub fn valid_username(s: &str) -> bool {
    let s = s.trim();
    (3..=32).contains(&s.len())
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noms_utilisateur() {
        assert!(valid_username("aymen"));
        assert!(valid_username("a.derbali-2"));
        assert!(!valid_username("ab"));
        assert!(!valid_username("Aymen"));
        assert!(!valid_username("-aymen"));
    }

    #[test]
    fn identifiant_appareil() {
        let id = random_b64(16);
        assert!(id.len() >= 16 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
