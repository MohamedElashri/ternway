//! Apply terminal configuration to the window that requested it.
use serde::Deserialize;
use tauri::{LogicalSize, Theme, WebviewWindow};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowSettings {
    title: String,
    fullscreen: Option<bool>,
    decorations: Option<bool>,
    theme: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
}

#[tauri::command]
pub(crate) fn configure_terminal_window(
    window: WebviewWindow,
    settings: WindowSettings,
) -> Result<(), String> {
    if settings.title.len() > 4096 || settings.title.chars().any(char::is_control) {
        return Err("Window title is too long or contains control characters".into());
    }
    let theme = match settings.theme.as_deref() {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        Some("system") => None,
        None => return apply_window(window, settings, None, false),
        _ => return Err("Invalid window theme".into()),
    };
    apply_window(window, settings, theme, true)
}

fn apply_window(
    window: WebviewWindow,
    settings: WindowSettings,
    theme: Option<Theme>,
    set_theme: bool,
) -> Result<(), String> {
    for dimension in [settings.width, settings.height].into_iter().flatten() {
        if !dimension.is_finite() || !(100.0..=32000.0).contains(&dimension) {
            return Err("Invalid window size".into());
        }
    }
    window
        .set_title(&settings.title)
        .map_err(|e| e.to_string())?;
    if let Some(decorations) = settings.decorations {
        window
            .set_decorations(decorations)
            .map_err(|e| e.to_string())?;
    }
    if set_theme {
        window.set_theme(theme).map_err(|e| e.to_string())?;
    }
    if settings.width.is_some() || settings.height.is_some() {
        let current = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        let mut size = LogicalSize::new(
            settings.width.unwrap_or(current.width),
            settings.height.unwrap_or(current.height),
        );
        if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
            let available = monitor
                .work_area()
                .size
                .to_logical::<f64>(monitor.scale_factor());
            size.width = size.width.min(available.width);
            size.height = size.height.min(available.height);
        }
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    if let Some(fullscreen) = settings.fullscreen {
        window
            .set_fullscreen(fullscreen)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
