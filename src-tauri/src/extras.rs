//! Pause/resume, direct client-source downloads, screenshots, and Discord presence.
use super::*;
use base64::Engine as _;
use std::io::{Read, Write};

pub static PAUSED: AtomicBool = AtomicBool::new(false);
pub const PAUSED_MESSAGE: &str = "Download paused.";

#[tauri::command]
pub fn pause_download() {
    PAUSED.store(true, Ordering::SeqCst);
}

/// Moves `src` into `dst`, merging directories and replacing files.
fn move_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|error| format!("Could not create {}: {error}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|error| format!("Could not read {}: {error}", src.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() && !to.is_file() {
            move_tree(&from, &to)?;
        } else {
            if to.is_dir() {
                fs::remove_dir_all(&to).map_err(|error| format!("Could not replace {}: {error}", to.display()))?;
            }
            fs::rename(&from, &to).map_err(|error| format!("Could not move {}: {error}", to.display()))?;
        }
    }
    Ok(())
}

/// Downloads a server-supplied .zip of the whole client (resumable, pausable) into an empty install folder.
/// Returns false when a client is already present. The manifest repair pass afterwards tops up anything missing.
#[tauri::command]
pub async fn install_from_source(app: tauri::AppHandle, settings: LauncherSettings) -> Result<bool, String> {
    let url = Url::parse(settings.client_source.trim()).map_err(|error| format!("Invalid client link: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || !url.path().to_ascii_lowercase().ends_with(".zip") {
        return Err("A direct client link must be an http(s) address ending in .zip.".to_string());
    }
    let root = game_root_from_settings(&settings, true)?;
    if root.join("Wow.exe").is_file() {
        return Ok(false);
    }
    PAUSED.store(false, Ordering::SeqCst);
    let work = root.join(".launcher").join("source");
    fs::create_dir_all(&work).map_err(|error| format!("Could not create {}: {error}", work.display()))?;
    let archive = work.join("client.zip");
    let total = match reqwest::Client::new().head(url.clone()).send().await {
        Ok(response) => response.content_length().unwrap_or(0),
        Err(_) => 0,
    };
    let started = Instant::now();
    copy_or_download_resumable(DownloadSource::Remote(url), &archive, None, |bytes| {
        emit_patch_progress(&app, "downloading-bundle", "client.zip", 0, 1, bytes, total, started)
    })
    .await?;

    emit_patch_progress(&app, "installing-bundle", "client.zip", 0, 1, total, total, started);
    let staged = work.join("extracted");
    let (zip_path, staged_path) = (archive.clone(), staged.clone());
    let extracted = tokio::task::spawn_blocking(move || extract_zip_safely(&zip_path, &staged_path))
        .await
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&archive); // a bad archive must not poison the next resume
    extracted?;

    let mut source = staged.clone();
    if !source.join("Wow.exe").is_file() {
        let nested = fs::read_dir(&staged)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.join("Wow.exe").is_file());
        source = nested.ok_or_else(|| "The downloaded archive does not contain Wow.exe.".to_string())?;
    }
    move_tree(&source, &root)?;
    let _ = fs::remove_dir_all(&work);
    Ok(true)
}

#[tauri::command]
pub fn open_torrent_link(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("magnet:?") || trimmed.len() > 4096 {
        return Err("Only magnet: links can be handed to a torrent client.".to_string());
    }
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(trimmed)
        .spawn()
        .map_err(|error| format!("Could not open your torrent client: {error}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    name: String,
    modified: u64,
    size: u64,
}

fn screenshot_dir(settings: &LauncherSettings) -> Result<PathBuf, String> {
    Ok(game_root_from_settings(settings, false)?.join("Screenshots"))
}

#[tauri::command]
pub fn list_screenshots(settings: LauncherSettings) -> Result<Vec<Screenshot>, String> {
    let dir = screenshot_dir(&settings)?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut shots: Vec<Screenshot> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let ext = name.rsplit('.').next()?.to_ascii_lowercase();
            if !["jpg", "jpeg", "png", "webp", "gif"].contains(&ext.as_str()) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some(Screenshot { name, modified: modified_stamp(&metadata), size: metadata.len() })
        })
        .collect();
    shots.sort_by(|a, b| b.modified.cmp(&a.modified));
    shots.truncate(200); // shortcut: newest 200 only, add paging if players keep more
    Ok(shots)
}

#[tauri::command]
pub fn read_screenshot(settings: LauncherSettings, name: String) -> Result<PickedFile, String> {
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err("Invalid screenshot name.".to_string());
    }
    let path = screenshot_dir(&settings)?.join(&name);
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read that screenshot: {error}"))?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err("That screenshot is larger than 16 MB.".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not read that screenshot: {error}"))?;
    let mime_type = if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) {
        "image/webp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        return Err("Only PNG, JPEG, WebP, and GIF screenshots can be shown.".to_string());
    };
    Ok(PickedFile {
        name,
        mime_type: mime_type.to_string(),
        data_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
    })
}

// ---- Discord rich presence (local IPC pipe, no Discord SDK) -------------------------------------------------------

static DISCORD: Mutex<Option<(String, fs::File)>> = Mutex::new(None);

fn discord_frame(opcode: u32, payload: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload.as_bytes());
    frame
}

fn discord_read(pipe: &mut fs::File) -> std::io::Result<()> {
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)?;
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if length > 64 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "oversized Discord frame"));
    }
    let mut body = vec![0u8; length];
    pipe.read_exact(&mut body)
}

fn discord_connect(client_id: &str) -> Option<fs::File> {
    for index in 0..10 {
        let Ok(mut pipe) = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\.\pipe\discord-ipc-{index}"))
        else {
            continue;
        };
        let hello = serde_json::json!({ "v": 1, "client_id": client_id }).to_string();
        if pipe.write_all(&discord_frame(0, &hello)).is_ok() && discord_read(&mut pipe).is_ok() {
            return Some(pipe);
        }
    }
    None
}

fn discord_send(client_id: &str, activity: serde_json::Value) -> Result<(), String> {
    let mut guard = DISCORD.lock().map_err(|_| "Discord state is poisoned.".to_string())?;
    let payload = serde_json::json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": activity },
        "nonce": now_millis().to_string()
    })
    .to_string();
    for _ in 0..2 {
        if guard.as_ref().map(|(id, _)| id != client_id).unwrap_or(true) {
            *guard = discord_connect(client_id).map(|pipe| (client_id.to_string(), pipe));
        }
        let Some((_, pipe)) = guard.as_mut() else {
            return Err("Discord is not running.".to_string());
        };
        if pipe.write_all(&discord_frame(1, &payload)).is_ok() && discord_read(pipe).is_ok() {
            return Ok(());
        }
        *guard = None; // stale pipe (Discord restarted): reconnect once
    }
    Err("Could not reach Discord.".to_string())
}

/// `details`/`state` are the two lines under the app name; an empty `details` clears the activity.
#[tauri::command]
pub async fn set_discord_presence(client_id: String, details: String, state: String, started: u64) -> Result<(), String> {
    if client_id.trim().is_empty() || !client_id.trim().chars().all(|c| c.is_ascii_digit()) {
        return Err("Set a numeric Discord application id first.".to_string());
    }
    let activity = if details.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!({
            "details": details.chars().take(128).collect::<String>(),
            "state": state.chars().take(128).collect::<String>(),
            "timestamps": { "start": started }
        })
    };
    tokio::task::spawn_blocking(move || discord_send(client_id.trim(), activity))
        .await
        .map_err(|error| error.to_string())?
}

// ---- Screenshot names, tags, and private notes ------------------------------------------------------------------

fn screenshot_meta_path(settings: &LauncherSettings) -> Result<PathBuf, String> {
    Ok(game_root_from_settings(settings, false)?.join(".launcher").join("screenshots.json"))
}

fn read_screenshot_meta(settings: &LauncherSettings) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = screenshot_meta_path(settings)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn write_screenshot_meta(
    settings: &LauncherSettings,
    meta: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let path = screenshot_meta_path(settings)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(meta).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("Could not save screenshot notes: {error}"))
}

fn screenshot_file(settings: &LauncherSettings, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err("Invalid screenshot name.".to_string());
    }
    let path = screenshot_dir(settings)?.join(name);
    if !path.is_file() {
        return Err("That screenshot no longer exists.".to_string());
    }
    Ok(path)
}

/// Tags and private notes per screenshot file name. These never leave the PC.
#[tauri::command]
pub fn load_screenshot_meta(settings: LauncherSettings) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Object(read_screenshot_meta(&settings)?))
}

#[tauri::command]
pub fn save_screenshot_meta(
    settings: LauncherSettings,
    name: String,
    tags: Vec<String>,
    note: String,
) -> Result<(), String> {
    screenshot_file(&settings, &name)?;
    let mut meta = read_screenshot_meta(&settings)?;
    let mut clean: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_string();
        if !tag.is_empty() && tag.len() <= 40 && !clean.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            clean.push(tag);
        }
    }
    clean.truncate(20);
    let note: String = note.chars().take(2000).collect();
    if clean.is_empty() && note.trim().is_empty() {
        meta.remove(&name);
    } else {
        meta.insert(name, serde_json::json!({ "tags": clean, "note": note }));
    }
    write_screenshot_meta(&settings, &meta)
}

/// Renames the file on disk (extension is kept) and moves its tags/note with it. Returns the new file name.
#[tauri::command]
pub fn rename_screenshot(settings: LauncherSettings, name: String, new_name: String) -> Result<String, String> {
    let old_path = screenshot_file(&settings, &name)?;
    let extension = old_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let mut stem = new_name.trim().to_string();
    if stem.to_ascii_lowercase().ends_with(&format!(".{}", extension.to_ascii_lowercase())) {
        stem.truncate(stem.len() - extension.len() - 1);
    }
    let stem = stem.trim().trim_end_matches('.').to_string();
    if stem.is_empty() || stem.len() > 100 || stem.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
        return Err("Use a file name without these characters: < > : quote / backslash | ? *".to_string());
    }
    let final_name = format!("{stem}.{extension}");
    if final_name == name {
        return Ok(name);
    }
    let new_path = old_path.with_file_name(&final_name);
    if new_path.exists() {
        return Err("A screenshot with that name already exists.".to_string());
    }
    fs::rename(&old_path, &new_path).map_err(|error| format!("Could not rename the screenshot: {error}"))?;
    let mut meta = read_screenshot_meta(&settings)?;
    if let Some(entry) = meta.remove(&name) {
        meta.insert(final_name.clone(), entry);
        write_screenshot_meta(&settings, &meta)?;
    }
    Ok(final_name)
}

// ---- Character portraits ------------------------------------------------------------------------------------------

static PORTRAITS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Every client archive, lowest priority first (patches and later names override earlier ones).
fn client_archives(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in [root.join("Data"), root.join("Data").join("enUS")] {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            // shortcut: archives over 8 GB (common-3) stall the reader and hold no portraits; skipped.
            let small = entry.metadata().is_ok_and(|meta| meta.len() < 8 << 30);
            if small && path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("mpq")) {
                found.push(path);
            }
        }
    }
    let key = |path: &PathBuf| {
        let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        (name.contains("patch"), name)
    };
    found.sort_by_key(key);
    found
}

fn read_from_archives(archives: &mut [wow_mpq::Archive], name: &str) -> Option<Vec<u8>> {
    for archive in archives.iter_mut().rev() {
        if matches!(archive.find_file(name), Ok(Some(_))) {
            if let Ok(data) = archive.read_file(name) {
                return Some(data);
            }
        }
    }
    None
}

/// Maps race id -> the client file name used in portrait paths, read from ChrRaces.dbc.
fn race_file_names(archives: &mut [wow_mpq::Archive]) -> HashMap<u32, String> {
    let mut names = HashMap::new();
    let Some(dbc) = read_from_archives(archives, r"DBFilesClient\ChrRaces.dbc") else { return names };
    let word = |at: usize| dbc.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if dbc.get(..4) != Some(b"WDBC") {
        return names;
    }
    let (Some(records), Some(fields), Some(size)) = (word(4), word(8), word(12)) else { return names };
    if fields < 12 {
        return names;
    }
    let strings = 20 + records as usize * size as usize;
    for index in 0..records as usize {
        let row = 20 + index * size as usize;
        let (Some(id), Some(offset)) = (word(row), word(row + 11 * 4)) else { continue };
        let Some(tail) = dbc.get(strings + offset as usize..) else { continue };
        let end = tail.iter().position(|&b| b == 0).unwrap_or(tail.len());
        names.insert(id, String::from_utf8_lossy(&tail[..end]).into_owned());
    }
    names
}

fn portrait_png(archives: &mut [wow_mpq::Archive], race_name: &str, gender: u8) -> Option<String> {
    let sex = if gender == 1 { "Female" } else { "Male" };
    let path = format!(r"Interface\CharacterFrame\TemporaryPortrait-{sex}-{race_name}.blp");
    let blp = image_blp::parser::parse_blp(&read_from_archives(archives, &path)?).ok()?.1;
    let image = image_blp::convert::blp_to_image(&blp, 0).ok()?;
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// Returns `"<raceId>-<gender>"` -> PNG data URL for every requested portrait the client files contain.
#[tauri::command]
pub async fn character_portraits(settings: LauncherSettings, keys: Vec<(u32, u8)>) -> Result<HashMap<String, String>, String> {
    let root = game_root_from_settings(&settings, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = HashMap::new();
        let mut missing = Vec::new();
        {
            let cache = PORTRAITS.lock().map_err(|_| "Portrait cache unavailable.".to_string())?;
            for &(race, gender) in &keys {
                let key = format!("{race}-{gender}");
                match cache.as_ref().and_then(|map| map.get(&key)) {
                    Some(url) => {
                        result.insert(key, url.clone());
                    }
                    None => missing.push((race, gender, key)),
                }
            }
        }
        if missing.is_empty() {
            return Ok(result);
        }
        let mut archives: Vec<wow_mpq::Archive> =
            client_archives(&root).iter().filter_map(|path| wow_mpq::Archive::open(path).ok()).collect();
        let races = race_file_names(&mut archives);
        let mut cache = PORTRAITS.lock().map_err(|_| "Portrait cache unavailable.".to_string())?;
        let cache = cache.get_or_insert_with(HashMap::new);
        for (race, gender, key) in missing {
            let Some(name) = races.get(&race) else { continue };
            if let Some(url) = portrait_png(&mut archives, name, gender) {
                cache.insert(key.clone(), url.clone());
                result.insert(key, url);
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}
