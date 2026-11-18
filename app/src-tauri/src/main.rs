// Évite une fenêtre console sous Windows en version finale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    relais_app_lib::run()
}
