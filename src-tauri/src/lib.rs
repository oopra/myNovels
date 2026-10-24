//! Novel Workbench native shell. The whole UI is the web app in ../dist/client; it talks to the
//! workbench server over HTTPS with a bearer token. Nothing is stored on the device except the
//! server URL and token in the webview's localStorage.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Novel Workbench");
}
