#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod natural;
mod state;
mod worker;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use state::{Config, HistoryEntry, ImageInfo, Manifest, Reader, Stats};

#[tauri::command]
fn open_folder(reader: tauri::State<'_, Arc<Reader>>, path: String) -> Result<Manifest, String> {
    reader.open_folder(&path)
}

#[tauri::command]
fn get_image(reader: tauri::State<'_, Arc<Reader>>, index: usize) -> Result<ImageInfo, String> {
    reader.get_image(index)
}

#[tauri::command]
fn set_current(reader: tauri::State<'_, Arc<Reader>>, index: usize, frac: f64) {
    reader.set_current(index, frac);
}

#[tauri::command]
fn get_settings(reader: tauri::State<'_, Arc<Reader>>) -> Config {
    reader.get_config()
}

#[tauri::command]
fn save_settings(reader: tauri::State<'_, Arc<Reader>>, config: Config) -> Result<(), String> {
    reader.save_config(config)
}

#[tauri::command]
fn get_stats(reader: tauri::State<'_, Arc<Reader>>) -> Stats {
    reader.stats()
}

#[tauri::command]
fn take_startup(reader: tauri::State<'_, Arc<Reader>>) -> Option<Manifest> {
    reader.pending.lock().unwrap().take()
}

#[tauri::command]
fn refresh_sources(
    reader: tauri::State<'_, Arc<Reader>>,
) -> Result<Vec<ImageInfo>, String> {
    reader.refresh_sources()
}

#[tauri::command]
fn get_history(reader: tauri::State<'_, Arc<Reader>>) -> Vec<HistoryEntry> {
    reader.recents()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(reader) = window.app_handle().try_state::<Arc<Reader>>() {
                    reader.flush_history();
                }
            }
        })
        .setup(|app| {
            let reader = Reader::new(app.handle().clone());
            worker::spawn(Arc::clone(&reader));

            // `toonreader.exe <folder>` (also works when a folder is dropped
            // onto the exe in Explorer). The frontend pulls the result once
            // its listeners are up, so no emit race is possible.
            if let Some(folder) = std::env::args().nth(1) {
                let reader = Arc::clone(&reader);
                std::thread::spawn(move || match reader.open_folder(&folder) {
                    Ok(m) => {
                        *reader.pending.lock().unwrap() = Some(m);
                        let _ = reader.app.emit("opened", ());
                    }
                    Err(e) => {
                        let _ = reader.app.emit("toast", e);
                    }
                });
            }

            app.manage(reader);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_folder,
            get_image,
            set_current,
            get_settings,
            save_settings,
            get_stats,
            take_startup,
            refresh_sources,
            get_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
