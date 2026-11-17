//! Native libghostty-vt adapter. Every FFI handle stays on one owning thread.
//! The webview receives render data, never a VT stream or a second emulator.
use crate::pty_output::OutputChannel;
use base64::Engine as _;
use ghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use ghostty_vt::render::{CellIterator, RowIterator};
use ghostty_vt::screen::{CellWide, GridRef, TrackedGridRef};
use ghostty_vt::selection::{FormatOptions, Selection};
use ghostty_vt::style::{Palette, RgbColor, Underline};
use ghostty_vt::terminal::{
    ClipboardWritePolicy, Mode, Point, PointCoordinate, PointSpace, ScrollViewport,
};
use ghostty_vt::{Event, RenderState, Terminal, TerminalOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{ipc::InvokeResponseBody, State, WebviewWindow};
#[path = "ghostty_images.rs"]
mod images;

type Result<T> = std::result::Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn color(c: RgbColor) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)
}
fn grapheme_text(grid: GridRef<'_>) -> Result<String> {
    let mut chars = ['\0'; 32];
    match grid.graphemes(&mut chars) {
        Ok(0) => Ok(" ".into()),
        Ok(n) => Ok(chars[..n].iter().collect()),
        Err(ghostty_vt::Error::OutOfSpace { required }) if required <= 65536 => {
            let mut chars = vec!['\0'; required];
            let n = grid.graphemes(&mut chars).map_err(error)?;
            Ok(chars[..n].iter().collect())
        }
        Err(reason) => Err(error(reason)),
    }
}
fn rgb(value: &str) -> Option<RgbColor> {
    let value = value.strip_prefix('#')?;
    if value.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(value, 16).ok()?;
    Some(RgbColor {
        r: (n >> 16) as u8,
        g: (n >> 8) as u8,
        b: n as u8,
    })
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Appearance {
    pub cols: u16,
    pub rows: u16,
    pub scrollback: usize,
    pub theme: HashMap<String, Value>,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub mac_option_is_meta: bool,
    pub image_storage_mb: usize,
}

#[derive(Serialize)]
struct Run {
    x: u16,
    width: u16,
    text: String,
    fg: String,
    bg: String,
    flags: u16,
    underline: String,
    link: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    cols: u16,
    rows: u16,
    lines: Vec<Option<Vec<Run>>>,
    cursor: Value,
    background: String,
    foreground: String,
    offset: u64,
    total: u64,
    bracketed_paste: bool,
    mouse: bool,
    alternate: bool,
    ack: usize,
    effects: Vec<Value>,
    row_ids: Vec<String>,
    marks: Vec<Value>,
    command_active: bool,
    cursor_screen_y: usize,
    cursor_x: u16,
    images: Vec<Value>,
    search_spans: Vec<[u32; 3]>,
    has_selection: bool,
}

#[derive(Default)]
struct Observer {
    escape: bool,
    osc: Option<Vec<u8>>,
    dcs: Option<Vec<u8>>,
    escaped: bool,
    overflow: bool,
}
struct CommandMark {
    prompt: TrackedGridRef,
    output: Option<TrackedGridRef>,
    end: Option<TrackedGridRef>,
    started: Option<std::time::Instant>,
    exit_code: Option<i32>,
    end_pending_wrap: bool,
    output_pending_wrap: bool,
}

struct Engine {
    // Tracked references must drop before their terminal.
    marks: std::collections::VecDeque<CommandMark>,
    observer: Observer,
    terminal: Terminal,
    render: RenderState,
    keys: ghostty_vt::key::Encoder,
    mouse: ghostty_vt::mouse::Encoder,
    appearance: Appearance,
    search_query: String,
    search_index: usize,
    image_cache: std::collections::HashSet<String>,
    search_ranges: Vec<(PointCoordinate, PointCoordinate)>,
    held_frame: Rc<RefCell<Option<Result<Frame>>>>,
    hold_since: Rc<Cell<Option<Instant>>>,
    force_full: Rc<Cell<bool>>,
}
impl Engine {
    fn new(appearance: Appearance) -> Result<Self> {
        if !(2..=1000).contains(&appearance.cols) || !(2..=500).contains(&appearance.rows) {
            return Err("Invalid terminal dimensions".into());
        }
        let mut terminal = Terminal::new(TerminalOptions {
            cols: appearance.cols,
            rows: appearance.rows,
            max_scrollback: Self::history_bytes(appearance.scrollback),
        })
        .map_err(error)?;
        // Remote OSC 52 must never overwrite the user's clipboard.
        terminal.set_clipboard_write_policy(ClipboardWritePolicy::Deny);
        terminal.set_continuation_max_bytes(65536).map_err(error)?;
        terminal
            .set_kitty_image_from_file_allowed(false)
            .map_err(error)?;
        terminal
            .set_kitty_image_from_shared_mem_allowed(false)
            .map_err(error)?;
        let held_frame = Rc::new(RefCell::new(None));
        let hold_since = Rc::new(Cell::new(None));
        let force_full = Rc::new(Cell::new(false));
        let (held, since, full) = (held_frame.clone(), hold_since.clone(), force_full.clone());
        terminal.set_render_hold(Some(Box::new(move |terminal, is_held| {
            full.set(true);
            if is_held {
                since.set(Some(Instant::now()));
                *held.borrow_mut() =
                    Some(RenderState::new().map_err(error).and_then(|mut render| {
                        Self::capture(
                            terminal,
                            &mut render,
                            &mut Default::default(),
                            0,
                            vec![],
                            false,
                        )
                    }));
            } else {
                since.set(None);
                held.borrow_mut().take();
            }
        })));
        let mut engine = Self {
            terminal,
            render: RenderState::new().map_err(error)?,
            keys: ghostty_vt::key::Encoder::new().map_err(error)?,
            mouse: ghostty_vt::mouse::Encoder::new().map_err(error)?,
            appearance: appearance.clone(),
            marks: Default::default(),
            observer: Default::default(),
            search_query: String::new(),
            search_index: 0,
            image_cache: Default::default(),
            search_ranges: Vec::new(),
            held_frame,
            hold_since,
            force_full,
        };
        engine.configure(appearance)?;
        Ok(engine)
    }
    fn history_bytes(bytes: usize) -> usize {
        bytes.min(1_000_000_000)
    }
    fn configure(&mut self, a: Appearance) -> Result<()> {
        let get = |key: &str| a.theme.get(key).and_then(Value::as_str).and_then(rgb);
        self.terminal
            .set_default_bg_color(get("background"))
            .map_err(error)?;
        self.terminal
            .set_default_fg_color(get("foreground"))
            .map_err(error)?;
        self.terminal
            .set_default_cursor_color(get("cursor"))
            .map_err(error)?;
        let mut palette = Palette::default();
        for (index, key) in [
            "black",
            "red",
            "green",
            "yellow",
            "blue",
            "magenta",
            "cyan",
            "white",
            "brightBlack",
            "brightRed",
            "brightGreen",
            "brightYellow",
            "brightBlue",
            "brightMagenta",
            "brightCyan",
            "brightWhite",
        ]
        .iter()
        .enumerate()
        {
            if let Some(c) = get(key) {
                palette.0[index] = c;
            }
        }
        if let Some(extended) = a.theme.get("extendedAnsi").and_then(Value::as_array) {
            for (i, value) in extended.iter().take(240).enumerate() {
                if let Some(c) = value.as_str().and_then(rgb) {
                    palette.0[i + 16] = c;
                }
            }
        }
        self.terminal
            .set_default_color_palette(Some(palette))
            .map_err(error)?;
        self.terminal
            .set_default_cursor_style(Some(match a.cursor_style.as_str() {
                "bar" => ghostty_vt::terminal::CursorStyle::Bar,
                "underline" => ghostty_vt::terminal::CursorStyle::Underline,
                _ => ghostty_vt::terminal::CursorStyle::Block,
            }))
            .map_err(error)?;
        self.terminal
            .set_default_cursor_blink(Some(a.cursor_blink))
            .map_err(error)?;
        self.terminal
            .set_scrollback_max_bytes(Some(Self::history_bytes(a.scrollback)))
            .map_err(error)?;
        self.terminal
            .set_kitty_image_storage_limit(a.image_storage_mb.min(1024) as u64 * 1_000_000)
            .map_err(error)?;
        self.terminal
            .set_apc_max_bytes_kitty(Some(a.image_storage_mb.clamp(1, 64) * 1_500_000))
            .map_err(error)?;
        self.appearance = a;
        Ok(())
    }
    fn write(&mut self, bytes: &[u8], live: bool) -> Vec<Value> {
        if !bytes.is_empty() {
            self.search_ranges.clear();
        }
        let mut effects = Vec::new();
        let mut begin = 0;
        for (i, &byte) in bytes.iter().enumerate() {
            // Observe shell marks only at actual VT ground boundaries. Ghostty still
            // receives every byte exactly once and owns all terminal parsing.
            if let Some(data) = self.observer.dcs.as_mut() {
                let done = self.observer.escaped && byte == b'\\';
                if data.len() < 24 * 1024 * 1024 {
                    data.push(byte);
                } else {
                    self.observer.overflow = true;
                }
                if done || byte == 0x18 || byte == 0x1a {
                    self.terminal.vt_write(&bytes[begin..=i]);
                    begin = i + 1;
                    let data = self.observer.dcs.take().unwrap();
                    if done && !self.observer.overflow && live {
                        if let Some((pixels, w, h)) =
                            images::sixel(&data, self.appearance.image_storage_mb)
                        {
                            self.terminal.vt_write(&images::kitty(&pixels, w, h));
                        }
                    }
                    self.observer.escaped = false;
                    self.observer.overflow = false;
                } else {
                    self.observer.escaped = byte == 27;
                }
            } else if self.observer.osc.is_some() {
                let done = byte == 7 || (self.observer.escaped && byte == b'\\');
                if byte == 0x18 || byte == 0x1a {
                    self.observer.osc = None;
                    self.observer.escaped = false;
                    self.observer.overflow = false;
                    continue;
                }
                if done {
                    self.terminal.vt_write(&bytes[begin..=i]);
                    begin = i + 1;
                    let data = self.observer.osc.take().unwrap();
                    if !self.observer.overflow {
                        let data = data.strip_suffix(b"\x1b").unwrap_or(&data);
                        if let Ok(data) = std::str::from_utf8(data) {
                            if let Some(mark) = data.strip_prefix("133;") {
                                self.command_mark(mark, &mut effects);
                            }
                        }
                        if live {
                            if let Some((pixels, w, h)) =
                                images::iterm(data, self.appearance.image_storage_mb)
                            {
                                self.terminal.vt_write(&images::kitty(&pixels, w, h));
                            }
                        }
                    }
                    self.observer.overflow = false;
                    self.observer.escaped = false;
                } else {
                    if let Some(data) = self.observer.osc.as_mut() {
                        let limit = if data.starts_with(b"1337;File=") {
                            24 * 1024 * 1024
                        } else {
                            65536
                        };
                        if data.len() < limit {
                            data.push(byte);
                        } else {
                            self.observer.overflow = true;
                        }
                    }
                    self.observer.escaped = byte == 27;
                }
            } else if self.observer.escape && byte == b'P' {
                self.observer.dcs = Some(b"\x1bP".to_vec());
                self.observer.escape = false;
            } else if self.observer.escape && byte == b']' {
                self.observer.osc = Some(Vec::new());
                self.observer.escape = false;
            } else {
                self.observer.escape = false;
                if byte == 27 {
                    self.terminal.vt_write(&bytes[begin..i]);
                    begin = i;
                    self.observer.escape =
                        self.terminal.vt_write_until_ground(&[]).ok().flatten() == Some(0);
                }
            }
        }
        self.terminal.vt_write(&bytes[begin..]);
        effects.extend(self.drain_events(live));
        effects
    }
    fn drain_events(&mut self, live: bool) -> Vec<Value> {
        self.terminal
            .events()
            .filter_map(|event| match event {
                Event::PtyWrite(bytes) if live => Some(json!({"kind":"reply","bytes":bytes})),
                Event::TitleChanged(title) => Some(json!({"kind":"title","title":title})),
                Event::PwdChanged(pwd) => Some(json!({"kind":"directory","uri":pwd})),
                Event::Bell => Some(json!({"kind":"bell"})),
                _ => None,
            })
            .collect()
    }
    fn command_mark(&mut self, data: &str, effects: &mut Vec<Value>) {
        let mut fields = data.split(';');
        let kind = fields.next().unwrap_or("");
        let cursor = || -> Result<TrackedGridRef> {
            self.terminal
                .track_grid_ref(Point::Active(PointCoordinate {
                    x: self.terminal.cursor_x().map_err(error)?,
                    y: self.terminal.cursor_y().map_err(error)? as u32,
                }))
                .map_err(error)
        };
        match kind {
            "A" => {
                if let Ok(prompt) = cursor() {
                    if self.marks.len() >= 256 {
                        self.marks.pop_front();
                    }
                    self.marks.push_back(CommandMark {
                        prompt,
                        output: None,
                        end: None,
                        started: None,
                        exit_code: None,
                        end_pending_wrap: false,
                        output_pending_wrap: false,
                    });
                }
            }
            "C" => {
                if let Ok(output) = cursor() {
                    if let Some(mark) = self.marks.back_mut() {
                        mark.output = Some(output);
                        mark.output_pending_wrap =
                            self.terminal.is_cursor_pending_wrap().unwrap_or(false);
                        mark.started = Some(std::time::Instant::now());
                    }
                }
            }
            "D" => {
                if let Ok(end) = cursor() {
                    if let Some(mark) = self.marks.back_mut() {
                        mark.end = Some(end);
                        mark.end_pending_wrap =
                            self.terminal.is_cursor_pending_wrap().unwrap_or(false);
                        mark.exit_code = fields.next().and_then(|v| v.parse::<i32>().ok());
                        if let Some(start) = mark.started.take() {
                            effects.push(json!({"kind":"finished","exitCode":mark.exit_code,"seconds":start.elapsed().as_secs_f64()}));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    fn last_output(&self) -> Result<Option<String>> {
        if self.terminal.active_screen().map_err(error)? == ghostty_vt::screen::Screen::Alternate {
            return Ok(None);
        }
        let Some(mark) = self
            .marks
            .iter()
            .rev()
            .find(|m| m.output.is_some() && m.end.is_some())
        else {
            return Ok(None);
        };
        let Some(mut start) = mark
            .output
            .as_ref()
            .unwrap()
            .point(PointSpace::Screen)
            .map_err(error)?
        else {
            return Ok(None);
        };
        let Some(mut end) = mark
            .end
            .as_ref()
            .unwrap()
            .point(PointSpace::Screen)
            .map_err(error)?
        else {
            return Ok(None);
        };
        if end == start && mark.end_pending_wrap == mark.output_pending_wrap {
            return Ok(Some(String::new()));
        }
        if mark.output_pending_wrap {
            start.x = 0;
            start.y += 1;
        }
        if mark.end_pending_wrap {
            // A full final row leaves the cursor on its last cell with wrap pending.
            // The endpoint is inclusive in this state, including wide-character tails.
        } else if end.x == 0 {
            end.y = end.y.saturating_sub(1);
            end.x = self.terminal.cols().map_err(error)? - 1;
        } else {
            end.x -= 1;
        }
        let selection = Selection::new(
            self.terminal
                .grid_ref(Point::Screen(start))
                .map_err(error)?,
            self.terminal.grid_ref(Point::Screen(end)).map_err(error)?,
            false,
        );
        let text = self
            .terminal
            .format_selection_alloc(
                FormatOptions::new()
                    .with_selection(&selection)
                    .with_unwrap(true)
                    .with_trim(true),
            )
            .map_err(error)?;
        Ok(text.map(|b| {
            String::from_utf8_lossy(&b)
                .trim_end_matches('\n')
                .to_string()
        }))
    }
    fn find(
        &mut self,
        query: &str,
        case_sensitive: bool,
        regex: bool,
        backwards: bool,
    ) -> Result<Value> {
        if query.len() > 4096 {
            return Err("Search is too long".into());
        }
        if query.is_empty() {
            self.clear_search()?;
            return Ok(json!({"resultIndex":-1,"resultCount":0}));
        }
        let expression = if regex {
            query.to_owned()
        } else {
            regex::escape(query)
        };
        let pattern = match regex::RegexBuilder::new(&expression)
            .case_insensitive(!case_sensitive)
            .size_limit(1024 * 1024)
            .build()
        {
            Ok(pattern) => pattern,
            Err(reason) => {
                self.clear_search()?;
                return Err(error(reason));
            }
        };
        let (text, positions) = match self.search_text() {
            Ok(text) => text,
            Err(reason) => {
                self.clear_search()?;
                return Err(reason);
            }
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut matches = Vec::new();
        for matched in pattern
            .find_iter(&text)
            .filter(|m| m.end() > m.start())
            .take(10000)
        {
            if Instant::now() > deadline {
                self.clear_search()?;
                return Err("Search pattern is too expensive; narrow the expression".into());
            }
            matches.push(matched);
        }
        self.search_ranges = matches
            .iter()
            .take(2000)
            .map(|m| (positions[m.start()], positions[m.end() - 1]))
            .collect();
        let key = format!("{case_sensitive}:{regex}:{query}");
        if matches.is_empty() {
            self.search_query = key;
            self.search_index = 0;
            self.terminal.set_selection(None).map_err(error)?;
            return Ok(json!({"resultIndex":-1,"resultCount":0}));
        }
        self.search_index = if self.search_query == key {
            if backwards {
                (self.search_index + matches.len() - 1) % matches.len()
            } else {
                (self.search_index + 1) % matches.len()
            }
        } else if backwards {
            matches.len() - 1
        } else {
            0
        };
        self.search_query = key;
        let matched = &matches[self.search_index];
        let start = positions[matched.start()];
        let end = positions[matched.end() - 1];
        let selection = Selection::new(
            self.terminal
                .grid_ref(Point::Screen(start))
                .map_err(error)?,
            self.terminal.grid_ref(Point::Screen(end)).map_err(error)?,
            false,
        );
        self.terminal
            .set_selection(Some(&selection))
            .map_err(error)?;
        self.terminal
            .scroll_viewport(ScrollViewport::Row(start.y as usize));
        Ok(json!({"resultIndex":self.search_index,"resultCount":matches.len()}))
    }
    fn search_text(&self) -> Result<(String, Vec<PointCoordinate>)> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut text = String::new();
        let mut positions = Vec::new();
        let total = self.terminal.total_rows().map_err(error)?;
        let cols = self.terminal.cols().map_err(error)?;
        for y in 0..total {
            if y % 64 == 0 && Instant::now() > deadline {
                return Err("Search history is too large; reduce scrollback-limit".into());
            }
            if text.len() > 16 * 1024 * 1024 {
                return Err("Search history exceeds 16 MiB of text".into());
            }
            let mut row = String::new();
            let mut points = Vec::new();
            let mut wrapped = false;
            for x in 0..cols {
                let point = PointCoordinate { x, y: y as u32 };
                let grid = self
                    .terminal
                    .grid_ref(Point::Screen(point))
                    .map_err(error)?;
                if x == 0 {
                    wrapped = grid.row().map_err(error)?.is_wrapped().map_err(error)?;
                }
                if matches!(
                    grid.cell().map_err(error)?.wide().map_err(error)?,
                    CellWide::SpacerTail | CellWide::SpacerHead
                ) {
                    continue;
                }
                let value = grapheme_text(grid)?;
                points.extend(std::iter::repeat_n(point, value.len()));
                row.push_str(&value);
            }
            if !wrapped {
                let len = row.trim_end().len();
                row.truncate(len);
                points.truncate(len);
            }
            text.push_str(&row);
            positions.extend(points);
            if !wrapped {
                text.push('\n');
                positions.push(PointCoordinate {
                    x: cols - 1,
                    y: y as u32,
                });
            }
        }
        Ok((text, positions))
    }
    fn clear_search(&mut self) -> Result<()> {
        self.search_query.clear();
        self.search_index = 0;
        self.search_ranges.clear();
        self.terminal.set_selection(None).map_err(error)?;
        Ok(())
    }
    fn frame(&mut self, ack: usize, effects: Vec<Value>, delta: bool) -> Result<Frame> {
        let full = self.force_full.replace(false);
        let mut frame = Self::capture(
            &self.terminal,
            &mut self.render,
            &mut self.image_cache,
            ack,
            effects,
            delta && !full,
        )?;
        self.decorate_frame(&mut frame)?;
        Ok(frame)
    }
    fn decorate_frame(&self, frame: &mut Frame) -> Result<()> {
        let mut search_spans = Vec::new();
        for &(start, end) in &self.search_ranges {
            for row in start.y.max(frame.offset as u32)
                ..=end.y.min((frame.offset + frame.rows as u64) as u32)
            {
                search_spans.push([
                    row,
                    if row == start.y { start.x as u32 } else { 0 },
                    if row == end.y {
                        end.x as u32 + 1
                    } else {
                        frame.cols as u32
                    },
                ]);
            }
        }

        frame.search_spans = search_spans;
        frame.command_active = !self.marks.is_empty();
        frame.marks = self
            .marks
            .iter()
            .filter_map(|m| {
                m.prompt
                    .point(PointSpace::Screen)
                    .ok()
                    .flatten()
                    .map(|p| json!({"row":p.y,"exitCode":m.exit_code}))
            })
            .collect();
        if frame.alternate {
            frame.command_active = false;
            frame.marks.clear();
        }
        Ok(())
    }
    fn capture(
        terminal: &Terminal,
        render: &mut RenderState,
        image_cache: &mut std::collections::HashSet<String>,
        ack: usize,
        effects: Vec<Value>,
        delta: bool,
    ) -> Result<Frame> {
        let snapshot = render.update(terminal).map_err(error)?;
        let colors = snapshot.colors().map_err(error)?;
        let cursor = snapshot.cursor().map_err(error)?;
        let mut rows = RowIterator::new().map_err(error)?;
        let mut row_iter = rows.update(&snapshot).map_err(error)?;
        let mut lines = Vec::new();
        let mut row_ids = Vec::new();
        while let Some(row) = row_iter.next() {
            row_ids.push(format!("{:?}", row.id().map_err(error)?));
            if delta
                && snapshot.dirty().map_err(error)? != ghostty_vt::render::Dirty::Full
                && !row.dirty().map_err(error)?
            {
                lines.push(None);
                continue;
            }

            let mut cells = CellIterator::new().map_err(error)?;
            let mut cell_iter = cells.update(row).map_err(error)?;
            let mut line: Vec<Run> = Vec::new();
            let mut x = 0u16;
            while let Some(cell) = cell_iter.next() {
                let raw = cell.raw_cell().map_err(error)?;
                let wide = raw.wide().map_err(error)?;
                if matches!(wide, CellWide::SpacerTail | CellWide::SpacerHead) {
                    x += 1;
                    continue;
                }
                let style = cell.style().map_err(error)?;
                let mut text = String::new();
                cell.graphemes_utf8(&mut text).map_err(error)?;
                if text.is_empty() {
                    text.push(' ');
                }
                let mut fg = cell.fg_color().map_err(error)?.unwrap_or(colors.foreground);
                let background = cell.bg_color().map_err(error)?;
                let mut bg = background.unwrap_or(colors.background);
                if style.inverse {
                    std::mem::swap(&mut fg, &mut bg);
                }
                let selected = cell.is_selected().map_err(error)?;
                let flags = u16::from(style.bold)
                    | u16::from(style.italic) << 1
                    | u16::from(style.faint) << 2
                    | u16::from(style.invisible) << 3
                    | u16::from(style.strikethrough) << 4
                    | u16::from(style.underline != Underline::None) << 5
                    | u16::from(style.overline) << 6
                    | u16::from(selected) << 7
                    | u16::from(background.is_some() || style.inverse) << 8;
                let width = if wide == CellWide::Wide { 2 } else { 1 };
                // Keep cell boundaries for pointer hit testing and wide graphemes.
                let link = if raw.has_hyperlink().map_err(error)? {
                    let mut uri = vec![0; 4096];
                    terminal
                        .grid_ref(Point::Viewport(PointCoordinate {
                            x,
                            y: lines.len() as u32,
                        }))
                        .ok()
                        .and_then(|g| g.hyperlink_uri(&mut uri).ok())
                        .filter(|&n| n <= uri.len())
                        .map(|n| String::from_utf8_lossy(&uri[..n]).into_owned())
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                line.push(Run {
                    x,
                    width,
                    text,
                    fg: color(fg),
                    bg: color(bg),
                    flags,
                    underline: String::new(),
                    link,
                });
                x += 1;
            }
            lines.push(Some(line));
        }
        let bar = terminal.scrollbar().map_err(error)?;
        let mut images = Vec::new();
        let mut visible_images = std::collections::HashSet::new();
        let graphics = terminal.kitty_graphics().map_err(error)?;
        let mut image_iterator = ghostty_vt::render::ImageIterator::new().map_err(error)?;
        let mut placements = image_iterator.update(&snapshot).map_err(error)?;
        while let Some(placement) = placements.next() {
            let p = placement.map_err(error)?;
            let Some(image) = graphics.image(p.image_id) else {
                continue;
            };
            let key = format!("{}:{}", p.image_id, p.image_generation);
            let first_placement = visible_images.insert(key.clone());
            let mut data = Value::Null;
            if first_placement && !image_cache.contains(&key) {
                use ghostty_vt::kitty::graphics::ImageFormat;
                let pixels = image.data().map_err(error)?;
                let rgba = match image.format().map_err(error)? {
                    ImageFormat::Rgba => pixels.to_vec(),
                    ImageFormat::Rgb => pixels
                        .as_chunks::<3>()
                        .0
                        .iter()
                        .flat_map(|p| [p[0], p[1], p[2], 255])
                        .collect(),
                    ImageFormat::Gray => pixels.iter().flat_map(|&p| [p, p, p, 255]).collect(),
                    ImageFormat::GrayAlpha => pixels
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .flat_map(|p| [p[0], p[0], p[0], p[1]])
                        .collect(),
                    _ => continue,
                };
                data = json!(base64::engine::general_purpose::STANDARD.encode(rgba));
            }
            images.push(json!({"key":key,"data":data,"width":image.width().map_err(error)?,"height":image.height().map_err(error)?,"x":p.viewport_col,"y":p.viewport_row,"offsetX":p.cell_offset_x,"offsetY":p.cell_offset_y,"drawWidth":p.pixel_width,"drawHeight":p.pixel_height,"sourceX":p.source_x,"sourceY":p.source_y,"sourceWidth":p.source_width,"sourceHeight":p.source_height,"above":matches!(p.layer,ghostty_vt::render::ImageLayer::AboveText),"layer":match p.layer {ghostty_vt::render::ImageLayer::BelowBackground=>"belowBackground",ghostty_vt::render::ImageLayer::BelowText=>"belowText",_=>"aboveText"},"z":p.z}));
        }
        *image_cache = visible_images;
        let frame = Frame {
            cols: snapshot.cols().map_err(error)?,
            rows: snapshot.rows().map_err(error)?,
            lines,
            cursor: json!({"x":cursor.viewport.map(|p|p.x),"y":cursor.viewport.map(|p|p.y),"visible":cursor.visible,"blink":cursor.blinking,"style":format!("{:?}",cursor.visual_style),"color":color(colors.cursor.unwrap_or(colors.foreground))}),
            background: color(colors.background),
            foreground: color(colors.foreground),
            offset: bar.offset,
            total: bar.total,
            bracketed_paste: terminal.mode(Mode::BRACKETED_PASTE).map_err(error)?,
            mouse: terminal.is_mouse_tracking().map_err(error)?,
            alternate: terminal.active_screen().map_err(error)?
                == ghostty_vt::screen::Screen::Alternate,
            ack,
            effects,
            row_ids,
            marks: Vec::new(),
            command_active: false,
            cursor_screen_y: terminal.scrollback_rows().map_err(error)?
                + terminal.cursor_y().map_err(error)? as usize,
            cursor_x: terminal.cursor_x().map_err(error)?,
            images,
            search_spans: Vec::new(),
            has_selection: terminal.selection().map_err(error)?.is_some(),
        };
        snapshot.clean().map_err(error)?;
        Ok(frame)
    }
    fn text(&self, format: Format, lines: usize) -> Result<String> {
        Self::format_screen(&self.terminal, format, lines.max(1))
    }
    fn snapshot(&self, lines: usize) -> Result<String> {
        let lines = lines.clamp(1, 1000);
        if self.terminal.active_screen().map_err(error)? != ghostty_vt::screen::Screen::Alternate {
            return self.text(Format::Vt, lines);
        }
        let bytes = ghostty_vt::snapshot::encode(&self.terminal).map_err(error)?;
        let mut cloned = ghostty_vt::snapshot::Decoder::from_slice(&bytes)
            .decode()
            .map_err(error)?;
        cloned.set_clipboard_write_policy(ClipboardWritePolicy::Deny);
        cloned.vt_write(b"\x18\x1b[?1049l\x1b[?1047l\x1b[?47l");
        Self::format_screen(&cloned, Format::Vt, lines)
    }
    fn format_screen(terminal: &Terminal, format: Format, lines: usize) -> Result<String> {
        let total = terminal.total_rows().map_err(error)?;
        let cols = terminal.cols().map_err(error)?;
        let start = terminal
            .grid_ref(Point::Screen(PointCoordinate {
                x: 0,
                y: total.saturating_sub(lines) as u32,
            }))
            .map_err(error)?;
        let end = terminal
            .grid_ref(Point::Screen(PointCoordinate {
                x: cols - 1,
                y: total.saturating_sub(1) as u32,
            }))
            .map_err(error)?;
        let selection = Selection::new(start, end, false);
        let mut formatter = Formatter::new(
            terminal,
            FormatterOptions::new()
                .with_format(format)
                .with_selection(&selection)
                .with_unwrap(true)
                .with_trim(true)
                .with_style(true),
        )
        .map_err(error)?;
        Ok(String::from_utf8_lossy(&formatter.format_alloc().map_err(error)?).into_owned())
    }
}

struct Pane {
    owner: String,
    engine: Engine,
    output: OutputChannel,
    route: Option<(crate::terminal::TerminalSessions, String)>,
    pending_replies: Vec<u8>,
}
impl Pane {
    fn expire_hold(&mut self) {
        if self
            .engine
            .hold_since
            .get()
            .is_some_and(|start| start.elapsed() >= Duration::from_secs(1))
        {
            self.engine.hold_since.set(None);
            self.engine.held_frame.borrow_mut().take();
            self.engine.force_full.set(true);
            if self
                .engine
                .terminal
                .set_mode(Mode::SYNC_OUTPUT, false)
                .is_ok()
            {
                if let Err(reason) = self.send(0, vec![]) {
                    self.render_failed(&reason);
                }
            }
        }
    }
    fn render_failed(&self, reason: &str) {
        let mut bytes = vec![1];
        bytes.extend(format!("Native terminal rendering failed: {reason}").as_bytes());
        let _ = self.output.send(InvokeResponseBody::Raw(bytes));
        if let Some((sessions, id)) = &self.route {
            let _ = crate::terminal::close(sessions, id);
        }
    }
    fn send(&mut self, ack: usize, mut effects: Vec<Value>) -> Result<()> {
        effects.retain(|effect| {
            if effect["kind"] != "reply" {
                return true;
            }
            if let Some(bytes) = effect["bytes"].as_array() {
                let bytes: Vec<u8> = bytes
                    .iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                    .collect();
                if let Some((sessions, id)) = &self.route {
                    let _ = crate::terminal::input_bytes(sessions, id, bytes);
                } else if self.pending_replies.len() + bytes.len() <= 65536 {
                    self.pending_replies.extend(bytes);
                }
            }
            false
        });
        let frozen = self.engine.held_frame.borrow_mut().take();
        let frame = if let Some(frozen) = frozen {
            let mut frame = frozen?;
            frame.ack = ack;
            frame.effects = effects;
            // Render holds freeze pixels, never input protocol state. In particular,
            // stale bracketed-paste state must not bypass multiline confirmation.
            frame.bracketed_paste = self
                .engine
                .terminal
                .mode(Mode::BRACKETED_PASTE)
                .map_err(error)?;
            frame.mouse = self.engine.terminal.is_mouse_tracking().map_err(error)?;
            frame.alternate = self.engine.terminal.active_screen().map_err(error)?
                == ghostty_vt::screen::Screen::Alternate;
            self.engine.decorate_frame(&mut frame)?;
            frame
        } else if self.engine.hold_since.get().is_some() {
            let payload = json!({"ack":ack,"effects":effects,"bracketedPaste":self.engine.terminal.mode(Mode::BRACKETED_PASTE).map_err(error)?,"mouse":self.engine.terminal.is_mouse_tracking().map_err(error)?,"alternate":self.engine.terminal.active_screen().map_err(error)?==ghostty_vt::screen::Screen::Alternate});
            let mut bytes = vec![3];
            bytes.extend(serde_json::to_vec(&payload).map_err(error)?);
            return self
                .output
                .send(InvokeResponseBody::Raw(bytes))
                .map_err(error);
        } else {
            self.engine.frame(ack, effects, true)?
        };
        let mut bytes = vec![2];
        bytes.extend(serde_json::to_vec(&frame).map_err(error)?);
        self.output
            .send(InvokeResponseBody::Raw(bytes))
            .map_err(error)
    }
}

type Job = Box<dyn FnOnce(&mut HashMap<String, Pane>) + Send>;
#[derive(Clone)]
pub(crate) struct EngineService {
    sender: mpsc::SyncSender<Job>,
}
impl Default for EngineService {
    fn default() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Job>(512);
        std::thread::Builder::new()
            .name("libghostty-vt".into())
            .spawn(move || {
                let mut panes = HashMap::new();
                loop {
                    let next = if panes
                        .values()
                        .any(|p: &Pane| p.engine.hold_since.get().is_some())
                    {
                        receiver.recv_timeout(Duration::from_millis(20))
                    } else {
                        receiver
                            .recv()
                            .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                    };
                    match next {
                        Ok(job) => job(&mut panes),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    for pane in panes.values_mut() {
                        pane.expire_hold();
                    }
                }
            })
            .expect("create native terminal engine thread");
        Self { sender }
    }
}
impl EngineService {
    fn call<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut HashMap<String, Pane>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (send, recv) = mpsc::sync_channel(1);
        self.sender
            .send(Box::new(move |panes| {
                let _ = send.send(job(panes));
            }))
            .map_err(error)?;
        recv.recv_timeout(Duration::from_secs(30)).map_err(error)?
    }
    pub(crate) fn bind(&self, owner: &str, id: &str) -> Result<OutputChannel> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        let checked_id = id.clone();
        self.call(move |panes| owned(panes, &owner, &checked_id).map(|_| ()))?;
        let sender = self.sender.clone();
        Ok(OutputChannel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let id = id.clone();
                sender
                    .send(Box::new(move |panes| {
                        if let Some(pane) = panes.get_mut(&id) {
                            if bytes.first() == Some(&0) {
                                let effects = pane.engine.write(&bytes[1..], true);
                                if let Err(reason) = pane.send(bytes.len() - 1, effects) {
                                    pane.render_failed(&reason);
                                }
                            } else {
                                let _ = pane.output.send(InvokeResponseBody::Raw(bytes));
                            }
                        }
                    }))
                    .map_err(|_| {
                        tauri::Error::Io(std::io::Error::other("Native terminal engine stopped"))
                    })?;
            }
            Ok(())
        }))
    }
    pub(crate) fn activate(
        &self,
        id: String,
        sessions: crate::terminal::TerminalSessions,
        session: String,
    ) -> Result<()> {
        self.call(move |panes| {
            let pane = panes.get_mut(&id).ok_or("Terminal engine closed")?;
            if !pane.pending_replies.is_empty() {
                crate::terminal::input_bytes(
                    &sessions,
                    &session,
                    std::mem::take(&mut pane.pending_replies),
                )?;
            }
            pane.route = Some((sessions, session));
            Ok(())
        })
    }
    pub(crate) fn close_window(&self, owner: String) {
        let _ = self
            .sender
            .send(Box::new(move |panes| panes.retain(|_, p| p.owner != owner)));
    }
}
fn owned<'a>(panes: &'a mut HashMap<String, Pane>, owner: &str, id: &str) -> Result<&'a mut Pane> {
    panes
        .get_mut(id)
        .filter(|p| p.owner == owner)
        .ok_or_else(|| "Terminal belongs to another window or has closed".into())
}

#[tauri::command(async)]
pub(crate) fn ghostty_create(
    window: WebviewWindow,
    service: State<'_, EngineService>,
    appearance: Appearance,
    on_output: OutputChannel,
) -> Result<String> {
    let owner = window.label().to_owned();
    service.call(move |panes| {
        if panes.values().filter(|p| p.owner == owner).count() >= 128 {
            return Err("Too many terminal panes".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let engine = Engine::new(appearance)?;
        let mut pane = Pane {
            owner,
            engine,
            output: on_output,
            route: None,
            pending_replies: Vec::new(),
        };
        pane.send(0, Vec::new())?;
        panes.insert(id.clone(), pane);
        Ok(id)
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Action {
    Configure {
        appearance: Appearance,
    },
    Resize {
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    },
    Write {
        text: String,
    },
    Scroll {
        row: usize,
    },
    Clear,
    Dispose,
    Snapshot {
        lines: usize,
    },
    Text {
        lines: usize,
    },
    Select {
        start: [u32; 2],
        end: [u32; 2],
        rectangle: bool,
    },
    SelectAll,
    SelectWord {
        point: [u32; 2],
    },
    SelectionText,
    ClearSelection,
    Key {
        code: String,
        text: Option<String>,
        mods: u16,
        release: bool,
        repeat: bool,
    },
    Paste {
        text: String,
    },
    Focus {
        focused: bool,
    },
    Search {
        query: String,
        case_sensitive: bool,
        regex: bool,
        backwards: bool,
    },
    LastOutput,
    Jump {
        direction: i8,
    },
    Completion,
    Mouse {
        x: f32,
        y: f32,
        button: i8,
        mods: u16,
        action: String,
        buttons: bool,
        cell_width: u32,
        cell_height: u32,
    },
}
#[tauri::command(async)]
pub(crate) fn ghostty_action(
    window: WebviewWindow,
    service: State<'_, EngineService>,
    id: String,
    action: Action,
) -> Result<Value> {
    let owner = window.label().to_owned();
    service.call(move |panes| {
        let pane = owned(panes, &owner, &id)?;
        if matches!(action, Action::Dispose) {
            panes.remove(&id);
            return Ok(Value::Null);
        }
        let engine = &mut pane.engine;
        let mut result = Value::Null;
        let mut effects = Vec::new();
        match action {
            Action::Configure { appearance } => engine.configure(appearance)?,
            Action::Resize {
                cols,
                rows,
                cell_width,
                cell_height,
            } => {
                if !(2..=1000).contains(&cols)
                    || !(2..=500).contains(&rows)
                    || cell_width > 1000
                    || cell_height > 1000
                {
                    return Err("Invalid terminal dimensions".into());
                }
                engine
                    .terminal
                    .resize(cols, rows, cell_width, cell_height)
                    .map_err(error)?;
                effects = engine.drain_events(true);
            }
            Action::Write { text } => {
                if text.len() > 4 * 1024 * 1024 {
                    return Err("Terminal snapshot too large".into());
                }
                effects = engine.write(text.as_bytes(), false);
            }
            Action::Scroll { row } => engine.terminal.scroll_viewport(ScrollViewport::Row(row)),
            Action::Clear => {
                engine.clear_search()?;
                effects = engine.write(b"\x18\x1b[3J\x1b[H\x1b[2J", false);
            }
            Action::SelectionText => {
                return Ok(json!(engine
                    .terminal
                    .format_selection_alloc(FormatOptions::new().with_unwrap(true))
                    .map_err(error)?
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default()))
            }
            Action::SelectWord { point } => {
                let grid = engine
                    .terminal
                    .grid_ref(Point::Screen(PointCoordinate {
                        x: point[0].min(999) as u16,
                        y: point[1],
                    }))
                    .map_err(error)?;
                let selection = engine
                    .terminal
                    .select_word(ghostty_vt::selection::SelectWordOptions::new(grid))
                    .map_err(error)?;
                engine
                    .terminal
                    .set_selection(selection.as_ref())
                    .map_err(error)?;
                result = json!(engine
                    .terminal
                    .format_selection_alloc(FormatOptions::new().with_unwrap(true))
                    .map_err(error)?
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default());
            }
            Action::Text { lines } => {
                return engine
                    .text(Format::Plain, lines.min(2000))
                    .map(Value::String)
            }
            Action::Snapshot { lines } => return engine.snapshot(lines).map(Value::String),
            Action::Select {
                start,
                end,
                rectangle,
            } => {
                let point = |p: [u32; 2]| {
                    Point::Screen(PointCoordinate {
                        x: p[0].min(999) as u16,
                        y: p[1],
                    })
                };
                let selection = Selection::new(
                    engine.terminal.grid_ref(point(start)).map_err(error)?,
                    engine.terminal.grid_ref(point(end)).map_err(error)?,
                    rectangle,
                );
                engine
                    .terminal
                    .set_selection(Some(&selection))
                    .map_err(error)?;
                result = json!(engine
                    .terminal
                    .format_selection_alloc(FormatOptions::new().with_unwrap(true))
                    .map_err(error)?
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default());
            }
            Action::SelectAll => {
                let selection = engine.terminal.select_all().map_err(error)?;
                engine
                    .terminal
                    .set_selection(selection.as_ref())
                    .map_err(error)?;
                result = json!(engine
                    .terminal
                    .format_selection_alloc(FormatOptions::new().with_unwrap(true))
                    .map_err(error)?
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default());
            }
            Action::ClearSelection => {
                engine.clear_search()?;
            }
            Action::Search {
                query,
                case_sensitive,
                regex,
                backwards,
            } => {
                result = engine.find(&query, case_sensitive, regex, backwards)?;
            }
            Action::LastOutput => return Ok(json!(engine.last_output()?)),
            Action::Completion => {
                let mut before = String::new();
                let y = engine.terminal.cursor_y().map_err(error)? as u32;
                for x in 0..engine.terminal.cursor_x().map_err(error)? {
                    let grid = engine
                        .terminal
                        .grid_ref(Point::Active(PointCoordinate { x, y }))
                        .map_err(error)?;
                    if matches!(
                        grid.cell().map_err(error)?.wide().map_err(error)?,
                        CellWide::SpacerTail | CellWide::SpacerHead
                    ) {
                        continue;
                    }
                    before.push_str(&grapheme_text(grid)?);
                }
                return Ok(
                    json!({"beforeCursor":before,"recent":engine.text(Format::Plain,2000)?}),
                );
            }
            Action::Mouse {
                x,
                y,
                button,
                mods,
                action,
                buttons,
                cell_width,
                cell_height,
            } => {
                use ghostty_vt::mouse::{Action as MouseAction, Button, EncoderSize, Position};
                if !x.is_finite() || !y.is_finite() || cell_width == 0 || cell_height == 0 {
                    return Err("Invalid pointer position".into());
                }
                let mut event = ghostty_vt::mouse::Event::new().map_err(error)?;
                event
                    .set_action(match action.as_str() {
                        "press" => MouseAction::Press,
                        "release" => MouseAction::Release,
                        _ => MouseAction::Motion,
                    })
                    .set_button(match button {
                        0 => Some(Button::Left),
                        1 => Some(Button::Middle),
                        2 => Some(Button::Right),
                        3 => Some(Button::Four),
                        4 => Some(Button::Five),
                        _ => None,
                    })
                    .set_mods(ghostty_vt::key::Mods::from_bits_truncate(mods))
                    .set_position(Position { x, y });
                engine
                    .mouse
                    .set_options_from_terminal(&engine.terminal)
                    .set_any_button_pressed(buttons)
                    .set_size(EncoderSize {
                        screen_width: engine.terminal.cols().map_err(error)? as u32 * cell_width,
                        screen_height: engine.terminal.rows().map_err(error)? as u32 * cell_height,
                        cell_width,
                        cell_height,
                        padding_top: 0,
                        padding_bottom: 0,
                        padding_right: 0,
                        padding_left: 0,
                    });
                let mut bytes = Vec::new();
                engine
                    .mouse
                    .encode_to_vec(&event, &mut bytes)
                    .map_err(error)?;
                if let Some((sessions, id)) = &pane.route {
                    let _ = crate::terminal::input_bytes(sessions, id, bytes);
                }
                return Ok(json!(""));
            }
            Action::Jump { direction } => {
                if engine.terminal.active_screen().map_err(error)?
                    == ghostty_vt::screen::Screen::Alternate
                {
                    return Ok(json!(false));
                }
                let offset = engine.terminal.scrollbar().map_err(error)?.offset as u32;
                let mut lines: Vec<u32> = engine
                    .marks
                    .iter()
                    .filter_map(|m| {
                        m.prompt
                            .point(PointSpace::Screen)
                            .ok()
                            .flatten()
                            .map(|p| p.y)
                    })
                    .collect();
                lines.sort_unstable();
                let row = if direction < 0 {
                    lines.into_iter().rev().find(|&row| row < offset)
                } else {
                    lines.into_iter().find(|&row| row > offset)
                };
                if let Some(row) = row {
                    engine
                        .terminal
                        .scroll_viewport(ScrollViewport::Row(row as usize));
                }
                result = json!(row.is_some());
            }
            Action::Key {
                code,
                text,
                mods,
                release,
                repeat,
            } => {
                let mut event = ghostty_vt::key::Event::new().map_err(error)?;
                if let Some(letter) = code
                    .strip_prefix("Key")
                    .filter(|s| s.len() == 1)
                    .and_then(|s| s.chars().next())
                {
                    event.set_unshifted_codepoint(letter.to_ascii_lowercase());
                }
                event
                    .set_key(key_code(&code))
                    .set_mods(ghostty_vt::key::Mods::from_bits_truncate(mods))
                    .set_action(if release {
                        ghostty_vt::key::Action::Release
                    } else if repeat {
                        ghostty_vt::key::Action::Repeat
                    } else {
                        ghostty_vt::key::Action::Press
                    })
                    .set_utf8(text);
                engine
                    .keys
                    .set_options_from_terminal(&engine.terminal)
                    .set_macos_option_as_alt(if engine.appearance.mac_option_is_meta {
                        ghostty_vt::key::OptionAsAlt::True
                    } else {
                        ghostty_vt::key::OptionAsAlt::False
                    });
                let mut bytes = Vec::new();
                engine
                    .keys
                    .encode_to_vec(&event, &mut bytes)
                    .map_err(error)?;
                if !release && !bytes.is_empty() {
                    engine.terminal.scroll_viewport(ScrollViewport::Bottom);
                }
                result = json!(String::from_utf8_lossy(&bytes));
            }
            Action::Paste { text } => {
                if text.len() > 1024 * 1024 {
                    return Err("Paste exceeds 1 MiB".into());
                }
                let mut bytes = text.into_bytes();
                let mut out = vec![0; bytes.len() * 2 + 32];
                let n = ghostty_vt::paste::encode(
                    &mut bytes,
                    engine.terminal.mode(Mode::BRACKETED_PASTE).map_err(error)?,
                    &mut out,
                )
                .map_err(error)?;
                result = json!(String::from_utf8_lossy(&out[..n]));
            }
            Action::Focus { focused } => {
                if engine.terminal.mode(Mode::FOCUS_EVENT).map_err(error)? {
                    if let Some((sessions, id)) = &pane.route {
                        let _ = crate::terminal::input_bytes(
                            sessions,
                            id,
                            if focused {
                                b"\x1b[I".to_vec()
                            } else {
                                b"\x1b[O".to_vec()
                            },
                        );
                    }
                }
            }
            Action::Dispose => unreachable!(),
        }
        if let Err(reason) = pane.send(0, effects) {
            pane.render_failed(&reason);
            return Err(reason);
        }
        Ok(result)
    })
}

fn key_code(code: &str) -> ghostty_vt::key::Key {
    use ghostty_vt::key::Key;
    match code {
        "Backquote" => Key::Backquote,
        "Backslash" => Key::Backslash,
        "BracketLeft" => Key::BracketLeft,
        "BracketRight" => Key::BracketRight,
        "Comma" => Key::Comma,
        "Digit0" => Key::Digit0,
        "Digit1" => Key::Digit1,
        "Digit2" => Key::Digit2,
        "Digit3" => Key::Digit3,
        "Digit4" => Key::Digit4,
        "Digit5" => Key::Digit5,
        "Digit6" => Key::Digit6,
        "Digit7" => Key::Digit7,
        "Digit8" => Key::Digit8,
        "Digit9" => Key::Digit9,
        "Equal" => Key::Equal,
        "IntlBackslash" => Key::IntlBackslash,
        "IntlRo" => Key::IntlRo,
        "IntlYen" => Key::IntlYen,
        "KeyA" => Key::A,
        "KeyB" => Key::B,
        "KeyC" => Key::C,
        "KeyD" => Key::D,
        "KeyE" => Key::E,
        "KeyF" => Key::F,
        "KeyG" => Key::G,
        "KeyH" => Key::H,
        "KeyI" => Key::I,
        "KeyJ" => Key::J,
        "KeyK" => Key::K,
        "KeyL" => Key::L,
        "KeyM" => Key::M,
        "KeyN" => Key::N,
        "KeyO" => Key::O,
        "KeyP" => Key::P,
        "KeyQ" => Key::Q,
        "KeyR" => Key::R,
        "KeyS" => Key::S,
        "KeyT" => Key::T,
        "KeyU" => Key::U,
        "KeyV" => Key::V,
        "KeyW" => Key::W,
        "KeyX" => Key::X,
        "KeyY" => Key::Y,
        "KeyZ" => Key::Z,
        "Minus" => Key::Minus,
        "Period" => Key::Period,
        "Quote" => Key::Quote,
        "Semicolon" => Key::Semicolon,
        "Slash" => Key::Slash,
        "AltLeft" => Key::AltLeft,
        "AltRight" => Key::AltRight,
        "Backspace" => Key::Backspace,
        "CapsLock" => Key::CapsLock,
        "ContextMenu" => Key::ContextMenu,
        "ControlLeft" => Key::ControlLeft,
        "ControlRight" => Key::ControlRight,
        "Enter" => Key::Enter,
        "MetaLeft" => Key::MetaLeft,
        "MetaRight" => Key::MetaRight,
        "ShiftLeft" => Key::ShiftLeft,
        "ShiftRight" => Key::ShiftRight,
        "Space" => Key::Space,
        "Tab" => Key::Tab,
        "Convert" => Key::Convert,
        "KanaMode" => Key::KanaMode,
        "NonConvert" => Key::NonConvert,
        "Delete" => Key::Delete,
        "End" => Key::End,
        "Help" => Key::Help,
        "Home" => Key::Home,
        "Insert" => Key::Insert,
        "PageDown" => Key::PageDown,
        "PageUp" => Key::PageUp,
        "ArrowDown" => Key::ArrowDown,
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "ArrowUp" => Key::ArrowUp,
        "NumLock" => Key::NumLock,
        "Numpad0" => Key::Numpad0,
        "Numpad1" => Key::Numpad1,
        "Numpad2" => Key::Numpad2,
        "Numpad3" => Key::Numpad3,
        "Numpad4" => Key::Numpad4,
        "Numpad5" => Key::Numpad5,
        "Numpad6" => Key::Numpad6,
        "Numpad7" => Key::Numpad7,
        "Numpad8" => Key::Numpad8,
        "Numpad9" => Key::Numpad9,
        "NumpadAdd" => Key::NumpadAdd,
        "NumpadBackspace" => Key::NumpadBackspace,
        "NumpadClear" => Key::NumpadClear,
        "NumpadClearEntry" => Key::NumpadClearEntry,
        "NumpadComma" => Key::NumpadComma,
        "NumpadDecimal" => Key::NumpadDecimal,
        "NumpadDivide" => Key::NumpadDivide,
        "NumpadEnter" => Key::NumpadEnter,
        "NumpadEqual" => Key::NumpadEqual,
        "NumpadMemoryAdd" => Key::NumpadMemoryAdd,
        "NumpadMemoryClear" => Key::NumpadMemoryClear,
        "NumpadMemoryRecall" => Key::NumpadMemoryRecall,
        "NumpadMemoryStore" => Key::NumpadMemoryStore,
        "NumpadMemorySubtract" => Key::NumpadMemorySubtract,
        "NumpadMultiply" => Key::NumpadMultiply,
        "NumpadParenLeft" => Key::NumpadParenLeft,
        "NumpadParenRight" => Key::NumpadParenRight,
        "NumpadSubtract" => Key::NumpadSubtract,
        "NumpadSeparator" => Key::NumpadSeparator,
        "NumpadUp" => Key::NumpadUp,
        "NumpadDown" => Key::NumpadDown,
        "NumpadRight" => Key::NumpadRight,
        "NumpadLeft" => Key::NumpadLeft,
        "NumpadBegin" => Key::NumpadBegin,
        "NumpadHome" => Key::NumpadHome,
        "NumpadEnd" => Key::NumpadEnd,
        "NumpadInsert" => Key::NumpadInsert,
        "NumpadDelete" => Key::NumpadDelete,
        "NumpadPageUp" => Key::NumpadPageUp,
        "NumpadPageDown" => Key::NumpadPageDown,
        "Escape" => Key::Escape,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        "F13" => Key::F13,
        "F14" => Key::F14,
        "F15" => Key::F15,
        "F16" => Key::F16,
        "F17" => Key::F17,
        "F18" => Key::F18,
        "F19" => Key::F19,
        "F20" => Key::F20,
        "F21" => Key::F21,
        "F22" => Key::F22,
        "F23" => Key::F23,
        "F24" => Key::F24,
        "F25" => Key::F25,
        "Fn" => Key::Fn,
        "FnLock" => Key::FnLock,
        "PrintScreen" => Key::PrintScreen,
        "ScrollLock" => Key::ScrollLock,
        "Pause" => Key::Pause,
        "BrowserBack" => Key::BrowserBack,
        "BrowserFavorites" => Key::BrowserFavorites,
        "BrowserForward" => Key::BrowserForward,
        "BrowserHome" => Key::BrowserHome,
        "BrowserRefresh" => Key::BrowserRefresh,
        "BrowserSearch" => Key::BrowserSearch,
        "BrowserStop" => Key::BrowserStop,
        "Eject" => Key::Eject,
        "LaunchApp1" => Key::LaunchApp1,
        "LaunchApp2" => Key::LaunchApp2,
        "LaunchMail" => Key::LaunchMail,
        "MediaPlayPause" => Key::MediaPlayPause,
        "MediaSelect" => Key::MediaSelect,
        "MediaStop" => Key::MediaStop,
        "MediaTrackNext" => Key::MediaTrackNext,
        "MediaTrackPrevious" => Key::MediaTrackPrevious,
        "Power" => Key::Power,
        "Sleep" => Key::Sleep,
        "AudioVolumeDown" => Key::AudioVolumeDown,
        "AudioVolumeMute" => Key::AudioVolumeMute,
        "AudioVolumeUp" => Key::AudioVolumeUp,
        "WakeUp" => Key::WakeUp,
        "Copy" => Key::Copy,
        "Cut" => Key::Cut,
        "Paste" => Key::Paste,
        _ => Key::Unidentified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_search_reopens_from_first_match_and_invalid_regex_clears_selection() {
        let mut engine = engine(80);
        engine.write(b"one one one", true);
        assert_eq!(
            engine.find("one", false, false, false).unwrap()["resultIndex"],
            0
        );
        engine.find("", false, false, false).unwrap();
        assert_eq!(
            engine.find("one", false, false, false).unwrap()["resultIndex"],
            0
        );
        assert!(engine.find("[", false, true, false).is_err());
        assert!(engine.search_ranges.is_empty());
        assert!(engine.terminal.selection().unwrap().is_none());
    }
    #[test]
    fn review_copy_output_keeps_a_last_column_character() {
        let mut engine = engine(20);
        engine.write(
            b"\x1b]133;A\x07$ command\r\n\x1b]133;C\x0712345678901234567890\x1b]133;D;0\x07",
            true,
        );
        assert_eq!(
            engine.last_output().unwrap().as_deref(),
            Some("12345678901234567890")
        );
        let mut one = self::engine(20);
        one.write(
            b"\x1b]133;A\x07abcdefghijklmnopqrs\x1b]133;C\x07X\x1b]133;D;0\x07",
            true,
        );
        assert_eq!(one.last_output().unwrap().as_deref(), Some("X"));
        one.write(b"\x1b[?1049hPRIVATE_EDITOR", true);
        assert_eq!(one.last_output().unwrap(), None);
    }
    #[test]
    fn review_search_preserves_long_combining_graphemes() {
        let mut engine = engine(80);
        let text = format!("a{}", "\u{301}".repeat(40));
        engine.write(text.as_bytes(), true);
        assert_eq!(
            engine.find(&text, true, false, false).unwrap()["resultCount"],
            1
        );
    }
    #[test]
    fn review_render_hold_is_atomic_acked_and_times_out() {
        use std::sync::{Arc, Mutex};
        let packets = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let captured = packets.clone();
        let mut pane = Pane {
            owner: "review".into(),
            engine: engine(80),
            output: OutputChannel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    captured.lock().unwrap().push(bytes);
                }
                Ok(())
            }),
            route: None,
            pending_replies: vec![],
        };
        let effects = pane
            .engine
            .write(b"\x1b[?2004hBEFORE\x1b[?2026h\x1b[?2004l\rAFTER", true);
        pane.send(42, effects).unwrap();
        let first = packets.lock().unwrap()[0].clone();
        assert_eq!(first[0], 2);
        let frame: Value = serde_json::from_slice(&first[1..]).unwrap();
        let text = frame["lines"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap())
            .collect::<String>();
        assert!(text.starts_with("BEFORE"));
        assert_eq!(frame["bracketedPaste"], false);
        assert_eq!(frame["ack"], 42);
        let effects = pane.engine.write(b" hidden", true);
        pane.send(7, effects).unwrap();
        let held = packets.lock().unwrap()[1].clone();
        assert_eq!(held[0], 3);
        assert_eq!(
            serde_json::from_slice::<Value>(&held[1..]).unwrap()["ack"],
            7
        );
        pane.engine
            .hold_since
            .set(Some(Instant::now() - Duration::from_secs(2)));
        pane.expire_hold();
        assert!(!pane.engine.terminal.mode(Mode::SYNC_OUTPUT).unwrap());
        let final_frame = packets.lock().unwrap().last().unwrap().clone();
        assert_eq!(final_frame[0], 2);
        let frame: Value = serde_json::from_slice(&final_frame[1..]).unwrap();
        assert!(frame["lines"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap())
            .collect::<String>()
            .starts_with("AFTER hidden"));
    }
    #[test]
    fn review_explicit_backgrounds_remain_distinct_from_default_cells() {
        let mut engine = engine(80);
        engine.write(b"A\x1b[40mB\x1b[0mC", true);
        let frame = engine.frame(0, vec![], false).unwrap();
        let row = frame.lines[0].as_ref().unwrap();
        assert_eq!(row[0].flags & 256, 0);
        assert_ne!(row[1].flags & 256, 0);
        assert_eq!(row[2].flags & 256, 0);
    }
    #[test]
    fn review_image_pixels_are_sent_once_for_multiple_placements() {
        let mut engine = engine(80);
        engine.terminal.resize(80, 24, 9, 20).unwrap();
        engine.write(
            b"\x1b_Ga=T,f=32,s=1,v=1,i=77,p=1;/wAA/w==\x1b\\\x1b_Ga=p,i=77,p=2;\x1b\\",
            true,
        );
        let frame = engine.frame(0, vec![], false).unwrap();
        assert_eq!(frame.images.len(), 2);
        assert_eq!(
            frame
                .images
                .iter()
                .filter(|image| !image["data"].is_null())
                .count(),
            1
        );
    }
    fn engine(cols: u16) -> Engine {
        Engine::new(Appearance {
            cols,
            rows: 5,
            scrollback: 1_000_000,
            theme: HashMap::new(),
            cursor_style: "block".into(),
            cursor_blink: false,
            mac_option_is_meta: true,
            image_storage_mb: 16,
        })
        .unwrap()
    }
    fn line(engine: &mut Engine, y: usize) -> String {
        engine.frame(0, vec![], false).unwrap().lines[y]
            .as_ref()
            .unwrap()
            .iter()
            .map(|c| c.text.as_str())
            .collect::<String>()
            .trim_end()
            .to_owned()
    }
    #[test]
    fn native_utf8_graphemes_and_wide_cells_across_frames() {
        let mut engine = engine(80);
        for &byte in "A界e\u{301}🙂Z".as_bytes() {
            engine.write(&[byte], true);
        }
        assert_eq!(line(&mut engine, 0), "A界e\u{301}🙂Z");
        assert_eq!(engine.terminal.cursor_x().unwrap(), 7);
        let frame = engine.frame(0, vec![], false).unwrap();
        assert_eq!(frame.lines[0].as_ref().unwrap()[1].width, 2);
        assert_eq!(frame.lines[0].as_ref().unwrap()[2].x, 3);
    }
    #[test]
    fn native_alternate_screen_reflow_and_colors() {
        let mut engine = engine(80);
        engine.write(b"shell history\x1b[?1049h\x1b[2J\x1b[H\x1b[38;2;1;2;3mEDITOR\x1b[2;4Hselection\x1b[?25l",true);
        assert_eq!(line(&mut engine, 0), "EDITOR");
        assert_eq!(line(&mut engine, 1), "   selection");
        assert_eq!(
            engine.frame(0, vec![], false).unwrap().lines[0]
                .as_ref()
                .unwrap()[0]
                .fg,
            "#010203"
        );
        assert!(!engine.frame(0, vec![], false).unwrap().cursor["visible"]
            .as_bool()
            .unwrap());
        for n in 0..100 {
            engine
                .terminal
                .resize(80 + n % 20, 24 + n % 10, 9, 20)
                .unwrap();
        }
        engine.write(b"\x1b[?1049l\x1b[?25h", true);
        assert_eq!(line(&mut engine, 0), "shell history");
    }
    #[test]
    fn native_shell_output_boundaries_include_partial_and_wrapped_rows() {
        for output in [
            "hello",
            "first\r\nlast",
            "first\r\nlast\r\n",
            "",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa終",
        ] {
            let mut engine = engine(20);
            let bytes=format!("\x1b]133;A\x07$ command\r\n\x1b]133;C\x07{output}\x1b]133;D;0\x07\x1b]133;A\x07$ next prompt");
            // Arbitrary PTY fragmentation must not change shell marks.
            for byte in bytes.as_bytes() {
                engine.write(&[*byte], true);
            }
            assert_eq!(
                engine.last_output().unwrap().as_deref(),
                Some(output.replace('\r', "").trim_end_matches('\n'))
            );
        }
        let mut engine = engine(80);
        engine.write(
            "\x1b]133;A\x07prefix: \x1b]133;C\x07result 終\x1b]133;D;0\x07 next prompt".as_bytes(),
            true,
        );
        assert_eq!(engine.last_output().unwrap().as_deref(), Some("result 終"));
    }
    #[test]
    fn restore_never_emits_input_and_osc52_is_denied() {
        let mut engine = engine(80);
        let events = engine.write(b"\x1b[6n\x1b]52;c;aGVsbG8=\x07", false);
        assert!(events.iter().all(|e| e["kind"] != "reply"));
        assert!(!engine
            .terminal
            .events()
            .any(|e| matches!(e, Event::ClipboardWrite(_))));
        assert!(engine
            .write(b"\x1b[6n", true)
            .iter()
            .any(|e| e["kind"] == "reply"));
    }
    #[test]
    fn snapshots_keep_bounded_colored_normal_history_without_program_modes() {
        let mut source = engine(80);
        source.write(
            b"old history\r\n0\r\n1\r\n2\r\n3\r\n\x1b[38;2;1;2;3mrecent history",
            true,
        );
        source.write(b"\x1b[?1049h\x1b[2JEDITOR\x1b[?2004h", true);
        let snapshot = source.snapshot(3).unwrap();
        assert!(!snapshot.contains("EDITOR"));
        assert!(!snapshot.contains("old history"));
        assert!(!snapshot.contains("2004"));
        let mut restored = engine(80);
        restored.write(snapshot.as_bytes(), false);
        let text = restored.text(Format::Plain, 100).unwrap();
        assert!(text.contains("recent history"));
        assert!(!restored.terminal.mode(Mode::BRACKETED_PASTE).unwrap());
        assert!(restored
            .frame(0, vec![], false)
            .unwrap()
            .lines
            .iter()
            .flatten()
            .flatten()
            .any(|cell| cell.text == "r" && cell.fg == "#010203"));
        let before = source.terminal.active_screen().unwrap();
        assert_eq!(before, ghostty_vt::screen::Screen::Alternate);
        source.write(b"\x1b]2;unfinished", true);
        let pending = source.snapshot(3).unwrap();
        assert!(pending.contains("recent history"));
        assert!(!pending.contains("EDITOR"));
        assert!(source
            .write(b" title\x07", true)
            .iter()
            .any(|event| event["kind"] == "title" && event["title"] == "unfinished title"));
        let mut partial = engine(80);
        partial.write(b"visible\x1b[", true);
        assert!(partial.snapshot(100).unwrap().contains("visible"));
    }
    #[test]
    fn search_maps_unicode_regex_and_soft_wraps_to_native_cells() {
        let mut engine = engine(10);
        engine.write("é界abc defghi\r\nONE one\r\n".as_bytes(), true);
        assert_eq!(
            engine.find("ONE", true, false, false).unwrap()["resultCount"],
            1
        );
        assert_eq!(
            engine.find("ONE", false, false, false).unwrap()["resultCount"],
            2
        );
        assert_eq!(
            engine.find("abc defghi", true, false, false).unwrap()["resultCount"],
            1
        );
        assert_eq!(
            engine.find("é界a.c", true, true, false).unwrap()["resultCount"],
            1
        );
        assert!(engine.find("[", false, true, false).is_err());
    }
    #[test]
    fn native_keyboard_tracks_application_mode() {
        use ghostty_vt::key::{Event as KeyEvent, Key};
        let mut engine = engine(80);
        let mut key = KeyEvent::new().unwrap();
        key.set_key(Key::ArrowUp);
        let encode = |engine: &mut Engine| {
            let mut out = Vec::new();
            engine
                .keys
                .set_options_from_terminal(&engine.terminal)
                .encode_to_vec(&key, &mut out)
                .unwrap();
            out
        };
        assert_eq!(encode(&mut engine), b"\x1b[A");
        engine.write(b"\x1b[?1h", true);
        assert_eq!(encode(&mut engine), b"\x1bOA");
        assert_eq!(ghostty_vt::key::Mods::CTRL.bits(), 2);
        assert_eq!(ghostty_vt::key::Mods::ALT.bits(), 4);
        let mut event = KeyEvent::new().unwrap();
        event
            .set_key(Key::C)
            .set_unshifted_codepoint('c')
            .set_utf8(Some("c"))
            .set_mods(ghostty_vt::key::Mods::CTRL);
        let mut out = Vec::new();
        engine
            .keys
            .set_options_from_terminal(&engine.terminal)
            .encode_to_vec(&event, &mut out)
            .unwrap();
        assert_eq!(out, b"\x03");
    }
    #[test]
    fn native_images_and_sixel_compatibility_use_ghostty_placements() {
        let mut native = engine(80);
        native.terminal.resize(80, 24, 9, 20).unwrap();
        native.write(&images::kitty(&[255, 0, 0, 255], 1, 1), true);
        let frame = native.frame(0, vec![], false).unwrap();
        assert_eq!(frame.images.len(), 1);
        assert_eq!(frame.images[0]["data"], "/wAA/w==");
        assert!(native.frame(0, vec![], true).unwrap().images[0]["data"].is_null());
        let mut sixel = engine(80);
        sixel.terminal.resize(80, 24, 9, 20).unwrap();
        for byte in b"\x1bPq#0;2;100;0;0#0~\x1b\\" {
            sixel.write(&[*byte], true);
        }
        assert_eq!(sixel.frame(0, vec![], false).unwrap().images.len(), 1);
    }
    #[test]
    fn dirty_render_packets_keep_unchanged_rows_native() {
        let mut engine = engine(80);
        engine.write(b"one\r\ntwo", true);
        assert!(engine
            .frame(0, vec![], true)
            .unwrap()
            .lines
            .iter()
            .all(Option::is_some));
        assert!(engine
            .frame(0, vec![], true)
            .unwrap()
            .lines
            .iter()
            .all(Option::is_none));
        engine.write(b"!", true);
        let patch = engine.frame(1, vec![], true).unwrap();
        assert!(patch.lines[0].is_none());
        assert!(patch.lines[1].is_some());
        assert_eq!(patch.ack, 1);
    }
    #[test]
    fn pane_ownership_is_enforced_on_the_native_actor() {
        let service = EngineService::default();
        service
            .call(|panes| {
                panes.insert(
                    "test".into(),
                    Pane {
                        owner: "main".into(),
                        engine: engine(80),
                        output: OutputChannel::new(|_| Ok(())),
                        route: None,
                        pending_replies: vec![],
                    },
                );
                Ok(())
            })
            .unwrap();
        assert!(service.bind("other", "test").is_err());
        let output = service.bind("main", "test").unwrap();
        output
            .send(InvokeResponseBody::Raw(b"\0actual native output".to_vec()))
            .unwrap();
        service
            .call(|panes| {
                assert_eq!(
                    line(&mut panes.get_mut("test").unwrap().engine, 0),
                    "actual native output"
                );
                Ok(())
            })
            .unwrap();
        service.close_window("main".into());
        assert!(service.bind("main", "test").is_err());
    }
    #[test]
    fn native_actor_answers_a_real_pty_without_webview_input() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };
        let service = EngineService::default();
        let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let captured = frames.clone();
        let done = closed.clone();
        let output = OutputChannel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                if bytes.first() == Some(&2) {
                    captured
                        .lock()
                        .unwrap()
                        .push(serde_json::from_slice(&bytes[1..]).unwrap());
                } else if bytes.first() == Some(&1) {
                    done.store(true, Ordering::SeqCst);
                }
            }
            Ok(())
        });
        service
            .call(move |panes| {
                panes.insert(
                    "pty".into(),
                    Pane {
                        owner: "main".into(),
                        engine: engine(80),
                        output,
                        route: None,
                        pending_replies: vec![],
                    },
                );
                Ok(())
            })
            .unwrap();
        let sessions = crate::terminal::TerminalSessions::default();
        let session_id = uuid::Uuid::new_v4().to_string();
        struct Cleanup(crate::terminal::TerminalSessions, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = crate::terminal::close(&self.0, &self.1);
            }
        }
        let _cleanup = Cleanup(sessions.clone(), session_id.clone());
        let started=crate::local_pty::start(service.bind("main","pty").unwrap(),sessions.clone(),crate::models::LocalTerminalRequest{
            session_id,cols:80,rows:24,cwd:None,env:vec![],shell_integration:Some("none".into()),
            command:Some(r#"/bin/sh -c "stty raw -echo; printf '\033[6n'; printf 'NATIVE_REPLY_'; dd bs=1 count=6 2>/dev/null | od -An -tu1""#.into()),
        }).unwrap();
        service
            .activate("pty".into(), sessions, started.session_id)
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !closed.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            closed.load(Ordering::SeqCst),
            "native engine must answer the terminal's cursor query"
        );
        let text = frames
            .lock()
            .unwrap()
            .iter()
            .flat_map(|frame| {
                frame["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_array)
                    .flatten()
                    .filter_map(|cell| cell["text"].as_str())
            })
            .collect::<String>();
        assert!(
            text.contains("NATIVE_REPLY_"),
            "actual PTY output must be rendered as native cells: {text:?}; frames: {:?}",
            frames.lock().unwrap()
        );
        let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.contains("27 91 49 59 49 82"),
            "cursor response bytes were altered: {normalized}"
        );
    }
}
