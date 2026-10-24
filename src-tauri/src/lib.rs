use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};

/// A further document window: its own tabs and autosave (keyed by `w`), showing the
/// library document `doc` when given.
fn open_document_window<R: Runtime>(app: &AppHandle<R>, doc: Option<String>) -> tauri::Result<()> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("{:x}", nanos & 0xffff_ffff_ffff);
    let mut url = format!("index.html?w={id}");
    if let Some(doc) = doc {
        let safe: String = doc.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        url.push_str(&format!("&doc={safe}"));
    }
    let window = WebviewWindowBuilder::new(app, format!("doc-{id}"), WebviewUrl::App(url.into()))
        .title("mathstudii")
        .inner_size(1280.0, 860.0)
        .min_inner_size(600.0, 400.0)
        .disable_drag_drop_handler()
        .build()?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn open_window(app: AppHandle, doc: Option<String>) -> Result<(), String> {
    open_document_window(&app, doc).map_err(|e| e.to_string())
}

/// The standard menu with File → New Window (Cmd+Shift+N), as Mac apps open a second window.
#[cfg(desktop)]
#[allow(dead_code)]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
    let menu = Menu::default(app)?;
    let new_window = MenuItem::with_id(app, "new-window", "New Window", true, Some("CmdOrCtrl+Shift+N"))?;
    let file = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(s) if s.text().ok().as_deref() == Some("File") => Some(s),
        _ => None,
    });
    match file {
        Some(file) => {
            file.prepend(&PredefinedMenuItem::separator(app)?)?;
            file.prepend(&new_window)?;
        }
        None => menu.insert(&Submenu::with_items(app, "File", true, &[&new_window])?, 1)?,
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![open_window])
        .setup(|_app| {
            // Windows and Linux keep their windows without a menu bar
            #[cfg(target_os = "macos")]
            {
                let menu = app_menu(_app.handle())?;
                _app.set_menu(menu)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "new-window" {
                let _ = open_document_window(app, None);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running mathstudii");
    app.run(|_app, _event| {
        // clicking the Dock icon with every window closed opens one again
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
            let _ = open_document_window(_app, None);
        }
    });
}
