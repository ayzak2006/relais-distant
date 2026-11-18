//! Injection souris/clavier via CGEvent (nécessite l'autorisation « Accessibilité »).

use crate::ffi::*;
use serde::Deserialize;
use std::time::{Duration, Instant};

/// Message envoyé par la visionneuse sur le canal de données.
#[derive(Deserialize, Debug)]
#[serde(tag = "k")]
pub enum InputMsg {
    /// Déplacement (coordonnées normalisées 0..1).
    #[serde(rename = "m")]
    Move { x: f64, y: f64 },
    #[serde(rename = "d")]
    Down { b: u8, x: f64, y: f64 },
    #[serde(rename = "u")]
    Up { b: u8, x: f64, y: f64 },
    /// Molette, en pixels.
    #[serde(rename = "w")]
    Wheel { dx: f64, dy: f64 },
    /// Touche physique (KeyboardEvent.code).
    #[serde(rename = "kd")]
    KeyDown { c: String },
    #[serde(rename = "ku")]
    KeyUp { c: String },
    /// Texte déjà composé (indépendant de la disposition du clavier du PC).
    #[serde(rename = "t")]
    Text { s: String },
    /// Demande d'image clé (gérée par la session).
    #[serde(rename = "kf")]
    KeyFrame,
    /// Relâche tout (perte de focus côté PC).
    #[serde(rename = "r")]
    Release,
}

const SHIFT: u64 = 0x20000;
const CONTROL: u64 = 0x40000;
const OPTION: u64 = 0x80000;
const COMMAND: u64 = 0x100000;

pub struct Injector {
    src: CGEventSourceRef,
    display: CGDirectDisplayID,
    flags: u64,
    buttons: [bool; 3],
    pos: CGPoint,
    last_click: (Instant, u8, i64),
    held_keys: Vec<u16>,
}
unsafe impl Send for Injector {}

impl Injector {
    pub fn new(display: CGDirectDisplayID) -> Self {
        Self {
            src: unsafe { CGEventSourceCreate(1) },
            display,
            flags: 0,
            buttons: [false; 3],
            pos: CGPoint::default(),
            last_click: (Instant::now() - Duration::from_secs(10), 255, 0),
            held_keys: Vec::new(),
        }
    }

    fn point(&mut self, x: f64, y: f64) -> CGPoint {
        let b = unsafe { CGDisplayBounds(self.display) };
        self.pos = CGPoint {
            x: b.origin.x + x.clamp(0.0, 1.0) * b.size.width,
            y: b.origin.y + y.clamp(0.0, 1.0) * b.size.height,
        };
        self.pos
    }

    fn post(&self, e: CGEventRef) {
        if e.is_null() {
            return;
        }
        unsafe {
            CGEventPost(0, e);
            CFRelease(e as CFTypeRef);
        }
    }

    pub fn handle(&mut self, msg: InputMsg) {
        match msg {
            InputMsg::Move { x, y } => {
                let p = self.point(x, y);
                let (kind, btn) = match self.buttons {
                    [true, ..] => (6, 0),
                    [_, true, _] => (7, 1),
                    [_, _, true] => (27, 2),
                    _ => (5, 0),
                };
                let e = unsafe { CGEventCreateMouseEvent(self.src, kind, p, btn) };
                unsafe { CGEventSetFlags(e, self.flags) };
                self.post(e);
            }
            InputMsg::Down { b, x, y } | InputMsg::Up { b, x, y } if b > 2 => {
                let _ = (x, y);
            }
            InputMsg::Down { b, x, y } => {
                let p = self.point(x, y);
                self.buttons[b as usize] = true;
                // Double/triple clic : même bouton, < 400 ms, à peu près au même endroit.
                let now = Instant::now();
                let count = if self.last_click.1 == b && now.duration_since(self.last_click.0) < Duration::from_millis(400) {
                    (self.last_click.2 % 3) + 1
                } else {
                    1
                };
                self.last_click = (now, b, count);
                self.mouse_button(b, true, p, count);
            }
            InputMsg::Up { b, x, y } => {
                let p = self.point(x, y);
                self.buttons[b as usize] = false;
                self.mouse_button(b, false, p, self.last_click.2.max(1));
            }
            InputMsg::Wheel { dx, dy } => {
                let e = unsafe { CGEventCreateScrollWheelEvent2(self.src, 0, 2, (-dy).round() as i32, (-dx).round() as i32, 0) };
                self.post(e);
            }
            InputMsg::KeyDown { c } => {
                if let Some(code) = keycode(&c) {
                    self.flags |= modifier_flag(code);
                    if !self.held_keys.contains(&code) {
                        self.held_keys.push(code);
                    }
                    self.key(code, true);
                }
            }
            InputMsg::KeyUp { c } => {
                if let Some(code) = keycode(&c) {
                    self.flags &= !modifier_flag(code);
                    self.held_keys.retain(|k| *k != code);
                    self.key(code, false);
                }
            }
            InputMsg::Text { s } => {
                for ch in s.chars().take(64) {
                    let mut buf = [0u16; 2];
                    let utf16 = ch.encode_utf16(&mut buf);
                    for down in [true, false] {
                        let e = unsafe { CGEventCreateKeyboardEvent(self.src, 0, down) };
                        unsafe {
                            CGEventSetFlags(e, 0);
                            CGEventKeyboardSetUnicodeString(e, utf16.len(), utf16.as_ptr());
                        }
                        self.post(e);
                    }
                }
            }
            InputMsg::Release => self.release_all(),
            InputMsg::KeyFrame => {}
        }
    }

    fn mouse_button(&self, b: u8, down: bool, p: CGPoint, count: i64) {
        let kind = match (b, down) {
            (0, true) => 1,
            (0, false) => 2,
            (1, true) => 3,
            (1, false) => 4,
            (_, true) => 25,
            (_, false) => 26,
        };
        let e = unsafe { CGEventCreateMouseEvent(self.src, kind, p, b as u32) };
        unsafe {
            CGEventSetIntegerValueField(e, 1, count); // kCGMouseEventClickState
            CGEventSetFlags(e, self.flags);
        }
        self.post(e);
    }

    fn key(&self, code: u16, down: bool) {
        let e = unsafe { CGEventCreateKeyboardEvent(self.src, code, down) };
        unsafe { CGEventSetFlags(e, self.flags) };
        self.post(e);
    }

    /// Relâche touches et boutons restés enfoncés (fin de session, perte de focus).
    pub fn release_all(&mut self) {
        for code in std::mem::take(&mut self.held_keys) {
            self.flags &= !modifier_flag(code);
            self.key(code, false);
        }
        self.flags = 0;
        for b in 0..3u8 {
            if self.buttons[b as usize] {
                self.buttons[b as usize] = false;
                self.mouse_button(b, false, self.pos, 1);
            }
        }
    }
}

impl Drop for Injector {
    fn drop(&mut self) {
        self.release_all();
        if !self.src.is_null() {
            unsafe { CFRelease(self.src as CFTypeRef) }
        }
    }
}

fn modifier_flag(code: u16) -> u64 {
    match code {
        56 | 60 => SHIFT,
        59 | 62 => CONTROL,
        58 | 61 => OPTION,
        55 | 54 => COMMAND,
        _ => 0,
    }
}

/// KeyboardEvent.code (position physique) → code virtuel macOS.
/// Clavier ISO (AZERTY) : « ² » et « < » sont inversés par rapport à l'ANSI.
fn keycode(code: &str) -> Option<u16> {
    Some(match code {
        "KeyA" => 0, "KeyS" => 1, "KeyD" => 2, "KeyF" => 3, "KeyH" => 4, "KeyG" => 5, "KeyZ" => 6,
        "KeyX" => 7, "KeyC" => 8, "KeyV" => 9, "Backquote" => 10, "KeyB" => 11, "KeyQ" => 12,
        "KeyW" => 13, "KeyE" => 14, "KeyR" => 15, "KeyY" => 16, "KeyT" => 17, "Digit1" => 18,
        "Digit2" => 19, "Digit3" => 20, "Digit4" => 21, "Digit6" => 22, "Digit5" => 23,
        "Equal" => 24, "Digit9" => 25, "Digit7" => 26, "Minus" => 27, "Digit8" => 28,
        "Digit0" => 29, "BracketRight" => 30, "KeyO" => 31, "KeyU" => 32, "BracketLeft" => 33,
        "KeyI" => 34, "KeyP" => 35, "Enter" => 36, "KeyL" => 37, "KeyJ" => 38, "Quote" => 39,
        "KeyK" => 40, "Semicolon" => 41, "Backslash" => 42, "Comma" => 43, "Slash" => 44,
        "KeyN" => 45, "KeyM" => 46, "Period" => 47, "Tab" => 48, "Space" => 49,
        "IntlBackslash" => 50, "Backspace" => 51, "Escape" => 53, "MetaRight" => 54,
        "MetaLeft" => 55, "ShiftLeft" => 56, "CapsLock" => 57, "AltLeft" => 58,
        "ControlLeft" => 59, "ShiftRight" => 60, "AltRight" => 61, "ControlRight" => 62,
        "F17" => 64, "NumpadDecimal" => 65, "NumpadMultiply" => 67, "NumpadAdd" => 69,
        "NumLock" => 71, "NumpadDivide" => 75, "NumpadEnter" => 76, "NumpadSubtract" => 78,
        "NumpadEqual" => 81, "Numpad0" => 82, "Numpad1" => 83, "Numpad2" => 84, "Numpad3" => 85,
        "Numpad4" => 86, "Numpad5" => 87, "Numpad6" => 88, "Numpad7" => 89, "Numpad8" => 91,
        "Numpad9" => 92, "F5" => 96, "F6" => 97, "F7" => 98, "F3" => 99, "F8" => 100,
        "F9" => 101, "F11" => 103, "F13" => 105, "F14" => 107, "F10" => 109, "ContextMenu" => 110,
        "F12" => 111, "F15" => 113, "Insert" => 114, "Home" => 115, "PageUp" => 116,
        "Delete" => 117, "F4" => 118, "End" => 119, "F2" => 120, "PageDown" => 121, "F1" => 122,
        "ArrowLeft" => 123, "ArrowRight" => 124, "ArrowDown" => 125, "ArrowUp" => 126,
        _ => return None,
    })
}
