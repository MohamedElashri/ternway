//! Use GTK's display clipboard on Linux. The plugin's data-control/X11 backend
//! cannot serve pure Wayland compositors without privileged data-control support.
use tauri::AppHandle;

#[cfg(target_os = "linux")]
fn clipboard() -> Result<gtk::Clipboard, String> {
    let display = gtk::gdk::Display::default().ok_or("Desktop display is unavailable")?;
    gtk::Clipboard::default(&display).ok_or_else(|| "Desktop clipboard is unavailable".into())
}

#[cfg(target_os = "linux")]
async fn response<T: Send + 'static>(
    receive: std::sync::mpsc::Receiver<Result<T, String>>,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Desktop clipboard did not respond".to_owned())?
    })
    .await
    .map_err(|reason| reason.to_string())?
}

#[tauri::command]
pub(crate) async fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || match clipboard() {
            Ok(clipboard) => clipboard.request_text(move |_, text| {
                let _ = send.send(Ok(text.unwrap_or_default().to_owned()));
            }),
            Err(reason) => {
                let _ = send.send(Err(reason));
            }
        })
        .map_err(|reason| reason.to_string())?;
        response(receive).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .read_text()
            .map_err(|reason| reason.to_string())
    }
}

#[tauri::command]
pub(crate) async fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if text.len() > i32::MAX as usize {
            return Err("Clipboard text is too large".into());
        }
        let (send, receive) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let result = clipboard().map(|clipboard| {
                clipboard.set_text(&text);
                clipboard.store();
            });
            let _ = send.send(result);
        })
        .map_err(|reason| reason.to_string())?;
        response(receive).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .write_text(text)
            .map_err(|reason| reason.to_string())
    }
}
