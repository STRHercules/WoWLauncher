#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures_util::StreamExt;
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use url::Url;

mod extras;

const SETTINGS_DIR: &str = "EsteriaLauncher";
const SETTINGS_FILE: &str = "settings.json";
const HASH_CACHE_FILE: &str = "hash-cache.json";
const SOCIAL_STATE_FILE: &str = "social-state.json";
const DEFAULT_MANIFEST_URL: &str = "http://planetkai.hopto.org:7384/api/v2/client/live/manifest.json";
const DEFAULT_ADDON_CATALOG_URL: &str = "http://planetkai.hopto.org:7384/api/v2/addons/catalog.json";
const DEFAULT_PATCH_NOTES_URL: &str = "http://planetkai.hopto.org:7384/api/v2/patchnotes.md";
const DEFAULT_NEWS_URL: &str = "http://planetkai.hopto.org:7384/api/v2/news.json";
const DEFAULT_STATUS_URL: &str = "http://planetkai.hopto.org:7384/api/v2/status";
const DEFAULT_SOCIAL_URL: &str = "http://planetkai.hopto.org:7384/api/v2/social.json";
const DEFAULT_ARMORY_URL: &str = "http://planetkai.hopto.org:8095/launcher/v1/armory";
const DEFAULT_DATABASE_URL: &str = "http://planetkai.hopto.org:8095/launcher/v1/database";
/// Snapshot endpoints the launcher used before the armory and database were served live by the game server.
const LEGACY_ARMORY_URL: &str = "http://planetkai.hopto.org:7384/api/v2/armory/characters.json";
const LEGACY_DATABASE_URL: &str = "http://planetkai.hopto.org:7384/api/v2/database/index.json";
const DEFAULT_ACCOUNT_API: &str = "http://planetkai.hopto.org:7384";
const DEFAULT_GAME_API: &str = "http://planetkai.hopto.org:8095";
const DEFAULT_REALM_HOST: &str = "planetkai.hopto.org";
const DEFAULT_REALM_PORT: u16 = 3724;
const DOWNLOAD_STALL_SECS: u64 = 60;
const PARALLEL_FILE_LIMIT: u64 = 64 * 1024 * 1024;
const PARALLEL_DOWNLOADS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSettings {
    #[serde(default)]
    settings_version: u32,
    #[serde(default)]
    game_path: String,
    #[serde(default = "default_channel")]
    channel: String,
    #[serde(default = "default_manifest_source")]
    manifest_source: String,
    #[serde(default = "default_addon_catalog_source")]
    addon_catalog_source: String,
    #[serde(default = "default_news_source")]
    news_source: String,
    #[serde(default = "default_patch_notes_source")]
    patch_notes_source: String,
    #[serde(default = "default_status_source")]
    status_source: String,
    #[serde(default = "default_social_source")]
    social_source: String,
    #[serde(default = "default_account_api")]
    account_api: String,
    /// Base address of the mod-launcher-api game server module (account, characters, presence).
    #[serde(default = "default_game_api")]
    game_api: String,
    /// Optional server-supplied client download: direct .zip link or magnet link. The CDN manifest stays the default.
    #[serde(default)]
    client_source: String,
    #[serde(default = "default_true")]
    discord_presence: bool,
    #[serde(default = "default_discord_client_id")]
    discord_client_id: String,
    #[serde(default = "default_armory_source")]
    armory_source: String,
    #[serde(default = "default_database_source")]
    database_source: String,
    #[serde(default = "default_true")]
    auto_update_addons: bool,
    #[serde(default = "default_realm_host")]
    realm_host: String,
    #[serde(default = "default_realm_port")]
    realm_port: u16,
    #[serde(default = "default_patch_list")]
    patch_list: String,
    #[serde(default = "default_true")]
    clean_wdb: bool,
    #[serde(default = "default_true")]
    minimize_on_play: bool,
    /// "ask", "close", "tray", or "minimize" — what the close button should do.
    #[serde(default = "default_close_action")]
    close_action: String,
    /// "ask", "minimize", "tray", or "keep" — what to do with the launcher when the game starts.
    #[serde(default = "default_play_action")]
    play_action: String,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            settings_version: 7,
            game_path: String::new(),
            channel: default_channel(),
            manifest_source: default_manifest_source(),
            addon_catalog_source: default_addon_catalog_source(),
            news_source: default_news_source(),
            patch_notes_source: default_patch_notes_source(),
            status_source: default_status_source(),
            social_source: default_social_source(),
            account_api: default_account_api(),
            game_api: default_game_api(),
            client_source: String::new(),
            discord_presence: true,
            discord_client_id: default_discord_client_id(),
            armory_source: default_armory_source(),
            database_source: default_database_source(),
            auto_update_addons: true,
            realm_host: default_realm_host(),
            realm_port: default_realm_port(),
            patch_list: default_patch_list(),
            clean_wdb: true,
            minimize_on_play: true,
            close_action: default_close_action(),
            play_action: default_play_action(),
        }
    }
}

fn default_close_action() -> String {
    "ask".to_string()
}

fn default_play_action() -> String {
    "ask".to_string()
}

fn normalize_window_action(value: &str, allowed: &[&str], fallback: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    if allowed.iter().any(|candidate| *candidate == trimmed) {
        trimmed
    } else {
        fallback.to_string()
    }
}

fn default_true() -> bool {
    true
}

fn default_channel() -> String {
    "live".to_string()
}

fn default_manifest_source() -> String {
    option_env!("ESTERIA_DEFAULT_MANIFEST")
        .unwrap_or(DEFAULT_MANIFEST_URL)
        .to_string()
}

fn default_addon_catalog_source() -> String {
    option_env!("ESTERIA_DEFAULT_ADDON_CATALOG")
        .unwrap_or(DEFAULT_ADDON_CATALOG_URL)
        .to_string()
}

fn default_patch_notes_source() -> String {
    option_env!("ESTERIA_DEFAULT_PATCH_NOTES")
        .unwrap_or(DEFAULT_PATCH_NOTES_URL)
        .to_string()
}

fn default_news_source() -> String {
    option_env!("ESTERIA_DEFAULT_NEWS")
        .unwrap_or(DEFAULT_NEWS_URL)
        .to_string()
}

fn default_status_source() -> String {
    option_env!("ESTERIA_DEFAULT_STATUS")
        .unwrap_or(DEFAULT_STATUS_URL)
        .to_string()
}

fn default_social_source() -> String {
    option_env!("ESTERIA_DEFAULT_SOCIAL")
        .unwrap_or(DEFAULT_SOCIAL_URL)
        .to_string()
}

fn default_account_api() -> String {
    option_env!("ESTERIA_DEFAULT_ACCOUNT_API")
        .unwrap_or(DEFAULT_ACCOUNT_API)
        .to_string()
}

fn default_game_api() -> String {
    option_env!("ESTERIA_DEFAULT_GAME_API")
        .unwrap_or(DEFAULT_GAME_API)
        .to_string()
}

fn default_discord_client_id() -> String {
    option_env!("ESTERIA_DEFAULT_DISCORD_CLIENT").unwrap_or("").to_string()
}

fn default_armory_source() -> String {
    option_env!("ESTERIA_DEFAULT_ARMORY")
        .unwrap_or(DEFAULT_ARMORY_URL)
        .to_string()
}

fn default_database_source() -> String {
    option_env!("ESTERIA_DEFAULT_DATABASE")
        .unwrap_or(DEFAULT_DATABASE_URL)
        .to_string()
}

fn default_patch_list() -> String {
    option_env!("ESTERIA_DEFAULT_PATCH_LIST")
        .unwrap_or(DEFAULT_REALM_HOST)
        .to_string()
}

fn default_realm_host() -> String {
    DEFAULT_REALM_HOST.to_string()
}

fn default_realm_port() -> u16 {
    DEFAULT_REALM_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchManifest {
    version: String,
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    files: Vec<PatchFile>,
    #[serde(default)]
    bundles: Vec<PatchBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchBundle {
    path: String,
    archive: String,
    sha256: String,
    size: u64,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchFile {
    path: String,
    sha256: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileIssue {
    path: String,
    kind: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationResult {
    manifest_version: Option<String>,
    total_files: usize,
    checked_files: usize,
    missing_files: usize,
    corrupt_files: usize,
    up_to_date: bool,
    manifest_configured: bool,
    client_installed: bool,
    install_root: String,
    issues: Vec<FileIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairResult {
    manifest_version: String,
    repaired_files: usize,
    skipped_files: usize,
    total_files: usize,
    client_installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchProgress {
    phase: String,
    current_file: String,
    completed_files: usize,
    total_files: usize,
    percent: u8,
    bytes_done: u64,
    bytes_total: u64,
    bytes_per_second: u64,
    eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealmStatus {
    online: bool,
    host: String,
    port: u16,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    settings_path: String,
    detected_game_path: Option<String>,
    launcher_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayerProfile {
    #[serde(default = "default_player_name")]
    display_name: String,
    #[serde(default = "default_presence")]
    presence: String,
    #[serde(default)]
    status_message: String,
    #[serde(default)]
    bio: String,
    #[serde(default)]
    favorite_character: String,
}

impl Default for PlayerProfile {
    fn default() -> Self {
        Self {
            display_name: default_player_name(),
            presence: default_presence(),
            status_message: String::new(),
            bio: String::new(),
            favorite_character: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FriendEntry {
    name: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    sender: String,
    body: String,
    sent_at: u64,
    #[serde(default)]
    read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    friend_name: String,
    #[serde(default)]
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocialPreferences {
    #[serde(default)]
    show_online_friends_only: bool,
    #[serde(default = "default_true")]
    desktop_notifications: bool,
    #[serde(default = "default_true")]
    show_character_details: bool,
}

impl Default for SocialPreferences {
    fn default() -> Self {
        Self {
            show_online_friends_only: false,
            desktop_notifications: true,
            show_character_details: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountSession {
    token: String,
    username: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    api_base: String,
    #[serde(default)]
    logged_in_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SocialState {
    #[serde(default)]
    profile: PlayerProfile,
    #[serde(default)]
    friends: Vec<FriendEntry>,
    #[serde(default)]
    conversations: Vec<Conversation>,
    #[serde(default)]
    preferences: SocialPreferences,
    #[serde(default)]
    account: Option<AccountSession>,
}

fn default_player_name() -> String {
    "Player".to_string()
}

fn default_presence() -> String {
    "online".to_string()
}

#[derive(Debug, Clone)]
enum ResourceOrigin {
    Remote(Url),
    Local(PathBuf),
}

#[derive(Debug, Clone)]
enum DownloadSource {
    Remote(Url),
    Local(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HashCacheEntry {
    size: u64,
    modified_ms: u64,
    sha256: String,
}

type HashCache = HashMap<String, HashCacheEntry>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonCatalog {
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    addons: Vec<AddonPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonPackage {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    changelog: String,
    package_url: String,
    sha256: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ManagedAddonsState {
    #[serde(default)]
    addons: HashMap<String, ManagedAddon>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedAddon {
    version: String,
    folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddonView {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    category: String,
    homepage: String,
    changelog: String,
    required: bool,
    installed_version: Option<String>,
    installed: bool,
    update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddonActionResult {
    id: String,
    name: String,
    version: Option<String>,
    action: String,
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = env::var_os("APPDATA")
        .or_else(|| env::var_os("LOCALAPPDATA"))
        .ok_or_else(|| "Windows application data directory could not be located.".to_string())?;
    Ok(PathBuf::from(base).join(SETTINGS_DIR))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(SETTINGS_FILE))
}

fn hash_cache_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(HASH_CACHE_FILE))
}

fn social_state_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(SOCIAL_STATE_FILE))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn load_social_state() -> SocialState {
    let Ok(path) = social_state_path() else {
        return SocialState::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return SocialState::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_social_state(state: &SocialState) -> Result<(), String> {
    let path = social_state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create launcher data directory: {error}"))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not serialize social state: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Could not save social state: {error}"))
}

fn load_settings_from_disk() -> LauncherSettings {
    let Ok(path) = settings_path() else {
        return LauncherSettings::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return LauncherSettings::default();
    };
    let mut settings: LauncherSettings = serde_json::from_str(&contents).unwrap_or_default();
    if settings.settings_version < 5 {
        if settings.channel.trim().is_empty() {
            settings.channel = default_channel();
        }
        if settings.manifest_source.trim().is_empty() {
            settings.manifest_source = default_manifest_source();
        }
        if settings.addon_catalog_source.trim().is_empty() {
            settings.addon_catalog_source = default_addon_catalog_source();
        }
        if settings.news_source.trim().is_empty() {
            settings.news_source = default_news_source();
        }
        if settings.status_source.trim().is_empty() {
            settings.status_source = default_status_source();
        }
        if settings.social_source.trim().is_empty() {
            settings.social_source = default_social_source();
        }
        if settings.armory_source.trim().is_empty() {
            settings.armory_source = default_armory_source();
        }
        if settings.database_source.trim().is_empty() {
            settings.database_source = default_database_source();
        }
        if settings.realm_host.trim().is_empty() || settings.realm_host == "127.0.0.1" {
            settings.realm_host = default_realm_host();
        }
        if settings.patch_list.trim().is_empty() {
            settings.patch_list = default_patch_list();
        }
        settings.settings_version = 5;
        let _ = save_settings_to_disk(&settings);
    }
    if settings.settings_version < 6 {
        if settings.account_api.trim().is_empty() {
            settings.account_api = default_account_api();
        }
        settings.settings_version = 6;
        let _ = save_settings_to_disk(&settings);
    }
    if settings.settings_version < 7 {
        if settings.armory_source == LEGACY_ARMORY_URL {
            settings.armory_source = default_armory_source();
        }
        if settings.database_source == LEGACY_DATABASE_URL {
            settings.database_source = default_database_source();
        }
        settings.settings_version = 7;
        let _ = save_settings_to_disk(&settings);
    }
    settings
}

fn save_settings_to_disk(settings: &LauncherSettings) -> Result<(), String> {
    let path = settings_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve launcher settings directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create launcher settings directory: {error}"))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize launcher settings: {error}"))?;
    fs::write(&path, json).map_err(|error| format!("Could not save launcher settings: {error}"))
}

fn load_hash_cache() -> HashCache {
    let Ok(path) = hash_cache_path() else {
        return HashMap::new();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_hash_cache(cache: &HashCache) -> Result<(), String> {
    let path = hash_cache_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve hash cache directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create hash cache directory: {error}"))?;
    fs::write(
        path,
        serde_json::to_vec(cache).map_err(|error| format!("Could not serialize hash cache: {error}"))?,
    )
    .map_err(|error| format!("Could not save hash cache: {error}"))
}

fn normalize_install_root(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose an Esteria installation folder first.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    let looks_like_wow_exe = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("wow.exe"))
        .unwrap_or(false);

    if looks_like_wow_exe {
        return candidate
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not determine the installation folder from Wow.exe.".to_string());
    }

    if candidate.exists() && !candidate.is_dir() {
        return Err("The selected install location is not a folder.".to_string());
    }

    Ok(candidate)
}

fn game_root_from_settings(settings: &LauncherSettings, create: bool) -> Result<PathBuf, String> {
    let root = normalize_install_root(&settings.game_path)?;
    if create && !root.exists() {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create install folder {}: {error}", root.display()))?;
    }
    Ok(root)
}

fn game_executable_from_settings(settings: &LauncherSettings) -> Result<PathBuf, String> {
    Ok(game_root_from_settings(settings, false)?.join("Wow.exe"))
}

fn likely_game_candidates() -> Vec<PathBuf> {
    let mut candidates = BTreeSet::new();

    let saved = load_settings_from_disk();
    if let Ok(root) = normalize_install_root(&saved.game_path) {
        candidates.insert(root);
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.insert(parent.to_path_buf());
            if let Some(grandparent) = parent.parent() {
                candidates.insert(grandparent.to_path_buf());
            }
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.insert(current_dir.clone());
        candidates.insert(current_dir.join("Esteria"));
    }

    for drive in ["C", "D", "E", "F", "G", "R"] {
        for relative in [
            "Esteria",
            "Games\\Esteria",
            "World of Warcraft",
            "Games\\World of Warcraft",
            "WoW",
        ] {
            candidates.insert(PathBuf::from(format!("{drive}:\\{relative}")));
        }
    }

    if let Some(user_profile) = env::var_os("USERPROFILE") {
        let user = PathBuf::from(user_profile);
        candidates.insert(user.join("Games").join("Esteria"));
        candidates.insert(user.join("Desktop").join("Esteria"));
        candidates.insert(user.join("Downloads").join("Esteria"));
    }

    candidates.into_iter().collect()
}

fn detect_game_path_internal() -> Option<PathBuf> {
    likely_game_candidates()
        .into_iter()
        .find(|candidate| candidate.join("Wow.exe").is_file())
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!("Path must be relative: {value}"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Unsafe relative path: {value}"));
            }
        }
    }
    Ok(path.to_path_buf())
}

fn modified_stamp(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 8 * 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn hash_cache_key(root: &Path, relative_key: &str) -> String {
    format!("{}|{}", root.to_string_lossy().to_lowercase(), relative_key.to_lowercase())
}

async fn cached_sha256(
    root: &Path,
    relative_key: &str,
    full_path: &Path,
    cache: &mut HashCache,
) -> Result<String, String> {
    let metadata = tokio::fs::metadata(full_path)
        .await
        .map_err(|error| format!("Could not inspect {}: {error}", full_path.display()))?;
    let modified_ms = modified_stamp(&metadata);
    let cache_key = hash_cache_key(root, relative_key);

    if let Some(entry) = cache.get(&cache_key) {
        if entry.size == metadata.len() && entry.modified_ms == modified_ms && !entry.sha256.is_empty() {
            return Ok(entry.sha256.clone());
        }
    }

    let sha256 = sha256_file(full_path).await?;
    cache.insert(
        cache_key,
        HashCacheEntry {
            size: metadata.len(),
            modified_ms,
            sha256: sha256.clone(),
        },
    );
    Ok(sha256)
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn parse_resource_origin(source: &str) -> Result<ResourceOrigin, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("No source is configured.".to_string());
    }

    if is_windows_drive_path(trimmed) {
        return Ok(ResourceOrigin::Local(PathBuf::from(trimmed)));
    }

    if let Ok(url) = Url::parse(trimmed) {
        return match url.scheme() {
            "http" | "https" => Ok(ResourceOrigin::Remote(url)),
            "file" => url
                .to_file_path()
                .map(ResourceOrigin::Local)
                .map_err(|_| "The file:// URL is invalid.".to_string()),
            scheme => Err(format!("Unsupported source scheme: {scheme}")),
        };
    }

    Ok(ResourceOrigin::Local(PathBuf::from(trimmed)))
}

async fn load_text_source(source: &str) -> Result<(String, ResourceOrigin), String> {
    let origin = parse_resource_origin(source)?;
    let text = match &origin {
        ResourceOrigin::Remote(url) => reqwest::Client::new()
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("Could not request {url}: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Request failed for {url}: {error}"))?
            .text()
            .await
            .map_err(|error| format!("Could not read response from {url}: {error}"))?,
        ResourceOrigin::Local(path) => tokio::fs::read_to_string(path)
            .await
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?,
    };
    Ok((text, origin))
}

async fn load_json_source(source: &str) -> Result<serde_json::Value, String> {
    let (text, _) = load_text_source(source).await?;
    serde_json::from_str(&text).map_err(|error| format!("Configured JSON endpoint returned invalid JSON: {error}"))
}

async fn load_json_source_query(source: &str, params: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    match parse_resource_origin(source)? {
        ResourceOrigin::Remote(mut url) => {
            {
                let mut pairs = url.query_pairs_mut();
                for (key, value) in params {
                    if !value.trim().is_empty() {
                        pairs.append_pair(key, value.trim());
                    }
                }
            }
            let response = reqwest::Client::new()
                .get(url.clone())
                .send()
                .await
                .map_err(|error| format!("Could not request {url}: {error}"))?
                .error_for_status()
                .map_err(|error| format!("Request failed for {url}: {error}"))?;
            response
                .json::<serde_json::Value>()
                .await
                .map_err(|error| format!("Configured JSON endpoint returned invalid JSON: {error}"))
        }
        ResourceOrigin::Local(_) => load_json_source(source).await,
    }
}

async fn load_manifest(source: &str) -> Result<(PatchManifest, ResourceOrigin), String> {
    let (text, origin) = load_text_source(source).await?;
    let manifest: PatchManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Patch manifest is not valid JSON: {error}"))?;

    if manifest.version.trim().is_empty() {
        return Err("Patch manifest is missing a version.".to_string());
    }
    if manifest.files.is_empty() {
        return Err("Patch manifest does not contain any files.".to_string());
    }

    for file in &manifest.files {
        validate_relative_path(&file.path)?;
        if file.sha256.len() != 64 || !file.sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("Manifest has an invalid SHA-256 for {}.", file.path));
        }
    }
    for bundle in &manifest.bundles {
        validate_relative_path(&bundle.path)?;
        validate_relative_path(&bundle.archive)?;
        if bundle.sha256.len() != 64 || !bundle.sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("Manifest has an invalid bundle SHA-256 for {}.", bundle.archive));
        }
        if bundle.size == 0 {
            return Err(format!("Manifest bundle {} has an invalid size.", bundle.archive));
        }
    }

    Ok((manifest, origin))
}

fn resolve_download_source(
    base_url: Option<&str>,
    origin: &ResourceOrigin,
    explicit_url: Option<&str>,
    fallback_path: &str,
) -> Result<DownloadSource, String> {
    let value = explicit_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_path);

    if is_windows_drive_path(value) {
        return Ok(DownloadSource::Local(PathBuf::from(value)));
    }

    if let Ok(url) = Url::parse(value) {
        return match url.scheme() {
            "http" | "https" => Ok(DownloadSource::Remote(url)),
            "file" => url
                .to_file_path()
                .map(DownloadSource::Local)
                .map_err(|_| format!("Invalid file URL: {value}")),
            scheme => Err(format!("Unsupported download scheme: {scheme}")),
        };
    }

    if Path::new(value).is_absolute() {
        return Ok(DownloadSource::Local(PathBuf::from(value)));
    }

    if let Some(base) = base_url.filter(|value| !value.trim().is_empty()) {
        if is_windows_drive_path(base) {
            return Ok(DownloadSource::Local(PathBuf::from(base).join(value)));
        }
        if let Ok(base_url) = Url::parse(base) {
            return match base_url.scheme() {
                "http" | "https" => base_url
                    .join(value)
                    .map(DownloadSource::Remote)
                    .map_err(|error| format!("Could not resolve download URL for {value}: {error}")),
                "file" => {
                    let base_path = base_url
                        .to_file_path()
                        .map_err(|_| "Configured baseUrl file path is invalid.".to_string())?;
                    Ok(DownloadSource::Local(base_path.join(value)))
                }
                scheme => Err(format!("Unsupported baseUrl scheme: {scheme}")),
            };
        }
        return Ok(DownloadSource::Local(PathBuf::from(base).join(value)));
    }

    match origin {
        ResourceOrigin::Remote(resource_url) => resource_url
            .join(value)
            .map(DownloadSource::Remote)
            .map_err(|error| format!("Could not resolve download URL for {value}: {error}")),
        ResourceOrigin::Local(resource_path) => Ok(DownloadSource::Local(
            resource_path.parent().unwrap_or_else(|| Path::new(".")).join(value),
        )),
    }
}

fn patch_file_source(
    manifest: &PatchManifest,
    origin: &ResourceOrigin,
    file: &PatchFile,
) -> Result<DownloadSource, String> {
    resolve_download_source(
        manifest.base_url.as_deref(),
        origin,
        file.url.as_deref(),
        &file.path,
    )
}

fn patch_bundle_source(
    manifest: &PatchManifest,
    origin: &ResourceOrigin,
    bundle: &PatchBundle,
) -> Result<DownloadSource, String> {
    resolve_download_source(
        manifest.base_url.as_deref(),
        origin,
        Some(&bundle.url),
        &bundle.archive,
    )
}

fn path_is_under(candidate: &str, parent: &str) -> Result<bool, String> {
    let candidate = validate_relative_path(candidate)?;
    let parent = validate_relative_path(parent)?;
    Ok(candidate == parent || candidate.starts_with(parent))
}

async fn file_matches(
    root: &Path,
    file: &PatchFile,
    cache: &mut HashCache,
) -> Result<bool, String> {
    let relative = validate_relative_path(&file.path)?;
    let destination = root.join(relative);
    if !destination.is_file() {
        return Ok(false);
    }
    if let Some(expected_size) = file.size {
        let actual_size = tokio::fs::metadata(&destination)
            .await
            .map_err(|error| format!("Could not read metadata for {}: {error}", file.path))?
            .len();
        if actual_size != expected_size {
            return Ok(false);
        }
    }
    let actual_hash = cached_sha256(root, &file.path, &destination, cache).await?;
    Ok(actual_hash.eq_ignore_ascii_case(file.sha256.trim()))
}

async fn copy_or_download_resumable<F>(
    source: DownloadSource,
    destination: &Path,
    expected_size: Option<u64>,
    mut on_file_bytes: F,
) -> Result<u64, String>
where
    F: FnMut(u64),
{
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    match source {
        DownloadSource::Local(path) => {
            tokio::fs::copy(&path, destination)
                .await
                .map_err(|error| format!("Could not copy {}: {error}", path.display()))?;
            let size = tokio::fs::metadata(destination)
                .await
                .map_err(|error| format!("Could not inspect {}: {error}", destination.display()))?
                .len();
            on_file_bytes(size);
            Ok(size)
        }
        DownloadSource::Remote(url) => {
            let mut resume_from = if destination.is_file() {
                tokio::fs::metadata(destination)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
            } else {
                0
            };

            if let Some(expected) = expected_size {
                if resume_from == expected {
                    on_file_bytes(resume_from);
                    return Ok(resume_from);
                }
                if resume_from > expected {
                    tokio::fs::File::create(destination)
                        .await
                        .map_err(|error| format!("Could not reset {}: {error}", destination.display()))?;
                    resume_from = 0;
                }
            }

            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| format!("Could not initialize downloader: {error}"))?;
            let mut request = client.get(url.clone());
            if resume_from > 0 {
                request = request.header(RANGE, format!("bytes={resume_from}-"));
            }

            let response = request
                .send()
                .await
                .map_err(|error| format!("Could not download {url}: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Download failed for {url}: HTTP {status}"));
            }

            let append = resume_from > 0 && status.as_u16() == 206;
            if resume_from > 0 && !append {
                resume_from = 0;
            }

            let mut output = if append {
                tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(destination)
                    .await
            } else {
                tokio::fs::File::create(destination).await
            }
            .map_err(|error| format!("Could not open {}: {error}", destination.display()))?;

            let mut file_bytes = resume_from;
            on_file_bytes(file_bytes);
            let mut stream = response.bytes_stream();
            while let Some(next_chunk) = timeout(Duration::from_secs(DOWNLOAD_STALL_SECS), stream.next())
                .await
                .map_err(|_| format!("Download stalled for {url}."))?
            {
                let bytes = next_chunk
                    .map_err(|error| format!("Download interrupted for {url}: {error}"))?;
                if extras::PAUSED.load(Ordering::Relaxed) {
                    let _ = output.flush().await;
                    return Err(extras::PAUSED_MESSAGE.to_string());
                }
                output
                    .write_all(&bytes)
                    .await
                    .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
                file_bytes = file_bytes.saturating_add(bytes.len() as u64);
                on_file_bytes(file_bytes);
            }
            output
                .flush()
                .await
                .map_err(|error| format!("Could not flush {}: {error}", destination.display()))?;
            Ok(file_bytes)
        }
    }
}

fn emit_patch_progress(
    app: &tauri::AppHandle,
    phase: &str,
    current_file: &str,
    completed_files: usize,
    total_files: usize,
    bytes_done: u64,
    bytes_total: u64,
    started: Instant,
) {
    let elapsed = started.elapsed().as_secs_f64();
    let bytes_per_second = if elapsed > 0.2 {
        (bytes_done as f64 / elapsed) as u64
    } else {
        0
    };
    let eta_seconds = if bytes_per_second > 0 && bytes_total > bytes_done {
        Some((bytes_total - bytes_done) / bytes_per_second)
    } else {
        None
    };
    let percent = if bytes_total > 0 {
        ((bytes_done.saturating_mul(100) / bytes_total).min(100)) as u8
    } else if total_files > 0 {
        ((completed_files.saturating_mul(100) / total_files).min(100)) as u8
    } else {
        100
    };
    let _ = app.emit(
        "patch-progress",
        PatchProgress {
            phase: phase.to_string(),
            current_file: current_file.to_string(),
            completed_files,
            total_files,
            percent,
            bytes_done,
            bytes_total,
            bytes_per_second,
            eta_seconds,
        },
    );
}

fn addon_state_path(root: &Path) -> PathBuf {
    root.join(".launcher").join("addons.json")
}

fn load_managed_addons(root: &Path) -> ManagedAddonsState {
    let path = addon_state_path(root);
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn save_managed_addons(root: &Path, state: &ManagedAddonsState) -> Result<(), String> {
    let path = addon_state_path(root);
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve addon state directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create addon state directory: {error}"))?;
    fs::write(
        path,
        serde_json::to_vec_pretty(state)
            .map_err(|error| format!("Could not serialize addon state: {error}"))?,
    )
    .map_err(|error| format!("Could not save addon state: {error}"))
}

async fn load_addon_catalog(source: &str) -> Result<(AddonCatalog, ResourceOrigin), String> {
    let (text, origin) = load_text_source(source).await?;
    let catalog: AddonCatalog = serde_json::from_str(&text)
        .map_err(|error| format!("Addon catalog is not valid JSON: {error}"))?;

    for addon in &catalog.addons {
        if addon.id.trim().is_empty() || addon.name.trim().is_empty() || addon.version.trim().is_empty() {
            return Err("Addon catalog contains an entry with a missing id, name, or version.".to_string());
        }
        if addon.sha256.len() != 64 || !addon.sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("Addon {} has an invalid SHA-256.", addon.name));
        }
        if addon.folders.is_empty() {
            return Err(format!("Addon {} does not declare any addon folders.", addon.name));
        }
        for folder in &addon.folders {
            let path = validate_relative_path(folder)?;
            if path.components().count() != 1 {
                return Err(format!("Addon folder must be a top-level folder name: {folder}"));
            }
        }
    }
    Ok((catalog, origin))
}

fn extract_zip_safely(zip_path: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .map_err(|error| format!("Could not clear {}: {error}", destination.display()))?;
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;

    let file = fs::File::open(zip_path)
        .map_err(|error| format!("Could not open ZIP {}: {error}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Invalid ZIP {}: {error}", zip_path.display()))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not read ZIP entry: {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("ZIP contains an unsafe path: {}", entry.name()))?
            .to_path_buf();
        let output_path = destination.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Could not create {}: {error}", output_path.display()))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        let mut output = fs::File::create(&output_path)
            .map_err(|error| format!("Could not create {}: {error}", output_path.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Could not extract {}: {error}", output_path.display()))?;
    }
    Ok(())
}

fn preserve_unmanaged_bundle_files(current: &Path, staged: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(current) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", current.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("Cannot safely preserve a link in a bundle folder: {}", current.display()));
    }
    if metadata.is_dir() {
        fs::create_dir_all(staged)
            .map_err(|error| format!("Could not preserve folder {}: {error}", current.display()))?;
        for entry in fs::read_dir(current)
            .map_err(|error| format!("Could not read {}: {error}", current.display()))?
        {
            let entry = entry.map_err(|error| format!("Could not read bundle folder: {error}"))?;
            preserve_unmanaged_bundle_files(&entry.path(), &staged.join(entry.file_name()))?;
        }
    } else if !staged.exists() {
        fs::copy(current, staged)
            .map_err(|error| format!("Could not preserve {}: {error}", current.display()))?;
    } else if !staged.is_file() {
        return Err(format!("Bundle folder conflicts with an existing file: {}", current.display()));
    }
    Ok(())
}

async fn install_patch_bundle(
    app: &tauri::AppHandle,
    root: &Path,
    manifest: &PatchManifest,
    origin: &ResourceOrigin,
    bundle: &PatchBundle,
    cache: &mut HashCache,
    base_bytes: u64,
    bytes_total: u64,
    started: Instant,
    bundle_position: usize,
    bundle_count: usize,
) -> Result<usize, String> {
    let launcher_dir = root.join(".launcher");
    let downloads_dir = launcher_dir.join("downloads");
    let staging_dir = launcher_dir.join("bundle-staging").join(format!("bundle-{bundle_position}"));
    tokio::fs::create_dir_all(&downloads_dir)
        .await
        .map_err(|error| format!("Could not create bundle download directory: {error}"))?;

    let archive_name = Path::new(&bundle.archive)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("bundle.zip");
    let archive_path = downloads_dir.join(format!("{bundle_position}-{archive_name}.part"));
    let source = patch_bundle_source(manifest, origin, bundle)?;
    let app_for_progress = app.clone();
    let bundle_label = bundle.path.clone();
    copy_or_download_resumable(source, &archive_path, Some(bundle.size), move |file_bytes| {
        emit_patch_progress(
            &app_for_progress,
            "downloading-bundle",
            &bundle_label,
            bundle_position,
            bundle_count,
            base_bytes.saturating_add(file_bytes),
            bytes_total,
            started,
        );
    })
    .await?;

    let archive_size = tokio::fs::metadata(&archive_path)
        .await
        .map_err(|error| format!("Could not inspect bundle {}: {error}", bundle.archive))?
        .len();
    if archive_size != bundle.size {
        return Err(format!(
            "Bundle {} has the wrong size. Expected {}, got {}.",
            bundle.archive, bundle.size, archive_size
        ));
    }
    let archive_hash = sha256_file(&archive_path).await?;
    if !archive_hash.eq_ignore_ascii_case(&bundle.sha256) {
        return Err(format!("Bundle failed SHA-256 verification: {}", bundle.archive));
    }

    emit_patch_progress(
        app,
        "installing-bundle",
        &bundle.path,
        bundle_position,
        bundle_count,
        base_bytes.saturating_add(bundle.size),
        bytes_total,
        started,
    );

    let archive_for_extract = archive_path.clone();
    let staging_for_extract = staging_dir.clone();
    tokio::task::spawn_blocking(move || extract_zip_safely(&archive_for_extract, &staging_for_extract))
        .await
        .map_err(|error| format!("Bundle extraction task failed: {error}"))??;

    let target_relative = validate_relative_path(&bundle.path)?;
    let target_name = target_relative
        .file_name()
        .ok_or_else(|| format!("Bundle path has no directory name: {}", bundle.path))?;
    let nested = staging_dir.join(target_name);
    let extracted_root = if nested.is_dir() { nested } else { staging_dir.clone() };

    let member_files: Vec<&PatchFile> = manifest
        .files
        .iter()
        .filter(|file| path_is_under(&file.path, &bundle.path).unwrap_or(false))
        .collect();
    if member_files.is_empty() {
        return Err(format!("Bundle {} has no managed files beneath {}.", bundle.archive, bundle.path));
    }

    for file in &member_files {
        let full_relative = validate_relative_path(&file.path)?;
        let inside = full_relative
            .strip_prefix(&target_relative)
            .map_err(|_| format!("Bundle member is outside target path: {}", file.path))?;
        let extracted_file = extracted_root.join(inside);
        if !extracted_file.is_file() {
            return Err(format!("Bundle {} is missing {}.", bundle.archive, file.path));
        }
        if let Some(expected_size) = file.size {
            let actual_size = tokio::fs::metadata(&extracted_file)
                .await
                .map_err(|error| format!("Could not inspect extracted {}: {error}", file.path))?
                .len();
            if actual_size != expected_size {
                return Err(format!("Bundle file size mismatch: {}", file.path));
            }
        }
        let hash = sha256_file(&extracted_file).await?;
        if !hash.eq_ignore_ascii_case(&file.sha256) {
            return Err(format!("Bundle file hash mismatch: {}", file.path));
        }
    }

    let target_dir = root.join(&target_relative);
    // Excluded files and player additions stay outside the bundle's managed selection.
    let current_for_preserve = target_dir.clone();
    let staged_for_preserve = extracted_root.clone();
    tokio::task::spawn_blocking(move || {
        preserve_unmanaged_bundle_files(&current_for_preserve, &staged_for_preserve)
    })
    .await
    .map_err(|error| format!("Bundle preservation task failed: {error}"))??;
    if let Some(parent) = target_dir.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create bundle target parent: {error}"))?;
    }
    let backup_dir = launcher_dir.join("bundle-backups").join(format!("bundle-{bundle_position}"));
    if backup_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&backup_dir).await;
    }
    if target_dir.exists() {
        if let Some(parent) = backup_dir.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Could not prepare bundle backup directory: {error}"))?;
        }
        tokio::fs::rename(&target_dir, &backup_dir)
            .await
            .map_err(|error| format!("Could not back up {}: {error}", target_dir.display()))?;
    }

    if let Err(error) = tokio::fs::rename(&extracted_root, &target_dir).await {
        let _ = tokio::fs::remove_dir_all(&target_dir).await;
        if backup_dir.exists() {
            let _ = tokio::fs::rename(&backup_dir, &target_dir).await;
        }
        return Err(format!("Could not install bundle {}: {error}", bundle.archive));
    }
    let _ = tokio::fs::remove_dir_all(&backup_dir).await;
    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
    let _ = tokio::fs::remove_file(&archive_path).await;

    for file in &member_files {
        let installed_path = root.join(validate_relative_path(&file.path)?);
        let metadata = tokio::fs::metadata(&installed_path)
            .await
            .map_err(|error| format!("Could not inspect installed {}: {error}", file.path))?;
        cache.insert(
            hash_cache_key(root, &file.path),
            HashCacheEntry {
                size: metadata.len(),
                modified_ms: modified_stamp(&metadata),
                sha256: file.sha256.clone(),
            },
        );
    }

    Ok(member_files.len())
}

async fn install_addon_package(
    settings: &LauncherSettings,
    catalog: &AddonCatalog,
    origin: &ResourceOrigin,
    addon: &AddonPackage,
) -> Result<AddonActionResult, String> {
    let root = game_root_from_settings(settings, true)?;
    let launcher_dir = root.join(".launcher");
    let downloads_dir = launcher_dir.join("downloads");
    let staging_dir = launcher_dir.join("addon-staging").join(&addon.id);
    tokio::fs::create_dir_all(&downloads_dir)
        .await
        .map_err(|error| format!("Could not create addon downloads directory: {error}"))?;

    let archive_path = downloads_dir.join(format!("{}-{}.zip.part", addon.id, addon.version));
    let source = resolve_download_source(
        catalog.base_url.as_deref(),
        origin,
        Some(&addon.package_url),
        &addon.package_url,
    )?;
    copy_or_download_resumable(source, &archive_path, addon.size, |_| {}).await?;

    if let Some(expected_size) = addon.size {
        let actual = tokio::fs::metadata(&archive_path)
            .await
            .map_err(|error| format!("Could not inspect addon archive: {error}"))?
            .len();
        if actual != expected_size {
            return Err(format!(
                "Addon package size mismatch for {}. Expected {expected_size}, got {actual}.",
                addon.name
            ));
        }
    }
    let actual_hash = sha256_file(&archive_path).await?;
    if !actual_hash.eq_ignore_ascii_case(&addon.sha256) {
        return Err(format!("Addon package failed SHA-256 verification: {}", addon.name));
    }

    let archive_for_extract = archive_path.clone();
    let staging_for_extract = staging_dir.clone();
    tokio::task::spawn_blocking(move || extract_zip_safely(&archive_for_extract, &staging_for_extract))
        .await
        .map_err(|error| format!("Addon extraction task failed: {error}"))??;

    let addons_root = root.join("Interface").join("AddOns");
    tokio::fs::create_dir_all(&addons_root)
        .await
        .map_err(|error| format!("Could not create AddOns directory: {error}"))?;

    for folder in &addon.folders {
        let source_folder = staging_dir.join(folder);
        if !source_folder.is_dir() {
            return Err(format!(
                "Addon package {} is missing declared folder {}.",
                addon.name, folder
            ));
        }
    }

    let mut state = load_managed_addons(&root);
    let previous_folders = state
        .addons
        .get(&addon.id)
        .map(|entry| entry.folders.clone())
        .unwrap_or_default();
    let backup_root = launcher_dir.join("addon-backups").join(&addon.id);
    if backup_root.exists() {
        let _ = tokio::fs::remove_dir_all(&backup_root).await;
    }
    tokio::fs::create_dir_all(&backup_root)
        .await
        .map_err(|error| format!("Could not prepare addon backup directory: {error}"))?;

    for folder in &addon.folders {
        let target_folder = addons_root.join(folder);
        if target_folder.exists() {
            tokio::fs::rename(&target_folder, backup_root.join(folder))
                .await
                .map_err(|error| format!("Could not back up addon folder {folder}: {error}"))?;
        }
    }

    let mut installed_folders: Vec<String> = Vec::new();
    for folder in &addon.folders {
        let source_folder = staging_dir.join(folder);
        let target_folder = addons_root.join(folder);
        if let Err(error) = tokio::fs::rename(&source_folder, &target_folder).await {
            for installed in &installed_folders {
                let _ = tokio::fs::remove_dir_all(addons_root.join(installed)).await;
            }
            for restore in &addon.folders {
                let backup = backup_root.join(restore);
                if backup.exists() {
                    let _ = tokio::fs::rename(&backup, addons_root.join(restore)).await;
                }
            }
            return Err(format!("Could not install addon folder {folder}: {error}"));
        }
        installed_folders.push(folder.clone());
    }

    for old_folder in previous_folders {
        if !addon.folders.iter().any(|folder| folder == &old_folder) {
            let _ = tokio::fs::remove_dir_all(addons_root.join(old_folder)).await;
        }
    }
    let _ = tokio::fs::remove_dir_all(&backup_root).await;

    state.addons.insert(
        addon.id.clone(),
        ManagedAddon {
            version: addon.version.clone(),
            folders: addon.folders.clone(),
        },
    );
    save_managed_addons(&root, &state)?;

    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
    let _ = tokio::fs::remove_file(&archive_path).await;

    Ok(AddonActionResult {
        id: addon.id.clone(),
        name: addon.name.clone(),
        version: Some(addon.version.clone()),
        action: "installed".to_string(),
    })
}

fn update_config_wtf(settings: &LauncherSettings) -> Result<(), String> {
    let root = game_root_from_settings(settings, false)?;
    let config_path = root.join("WTF").join("Config.wtf");
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create WTF directory: {error}"))?;
    }

    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| {
            let lower = line.trim().to_ascii_lowercase();
            !lower.starts_with("set realmlist ") && !lower.starts_with("set patchlist ")
        })
        .map(str::to_string)
        .collect();

    lines.push(format!("SET realmlist \"{}\"", settings.realm_host.trim()));
    if !settings.patch_list.trim().is_empty() {
        lines.push(format!("SET patchlist \"{}\"", settings.patch_list.trim()));
    }

    let temp = config_path.with_extension("wtf.esteria-temp");
    fs::write(&temp, format!("{}\r\n", lines.join("\r\n")))
        .map_err(|error| format!("Could not write Config.wtf: {error}"))?;
    if config_path.exists() {
        fs::remove_file(&config_path)
            .map_err(|error| format!("Could not replace Config.wtf: {error}"))?;
    }
    fs::rename(&temp, &config_path)
        .map_err(|error| format!("Could not install Config.wtf: {error}"))?;
    Ok(())
}

fn is_game_running() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Wow.exe", "/FO", "CSV", "/NH"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("wow.exe"))
        .unwrap_or(false)
}

#[tauri::command]
fn get_settings() -> LauncherSettings {
    load_settings_from_disk()
}

#[tauri::command]
fn save_settings(mut settings: LauncherSettings) -> Result<LauncherSettings, String> {
    settings.settings_version = 7;
    settings.channel = settings.channel.trim().to_ascii_lowercase();
    if settings.channel != "live" && settings.channel != "ptr" {
        return Err("Game channel must be either live or ptr.".to_string());
    }
    if !settings.game_path.trim().is_empty() {
        let _ = normalize_install_root(&settings.game_path)?;
    }
    if settings.realm_host.trim().is_empty() {
        return Err("Realm host cannot be empty.".to_string());
    }
    if settings.realm_port == 0 {
        return Err("Realm port must be between 1 and 65535.".to_string());
    }
    save_settings_to_disk(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn detect_game_path() -> Option<String> {
    detect_game_path_internal().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn choose_install_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose Esteria install folder")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn launch_game(app: tauri::AppHandle, settings: LauncherSettings) -> Result<(), String> {
    let executable = game_executable_from_settings(&settings)?;
    if !executable.is_file() {
        return Err("Esteria is not installed yet. Run Install/Update first.".to_string());
    }
    if is_game_running() {
        return Err("World of Warcraft is already running.".to_string());
    }

    update_config_wtf(&settings)?;
    let root = executable
        .parent()
        .ok_or_else(|| "Could not determine the game directory.".to_string())?
        .to_path_buf();
    if settings.clean_wdb {
        let _ = fs::remove_dir_all(root.join("WDB"));
    }

    let mut child = Command::new(&executable)
        .current_dir(&root)
        .spawn()
        .map_err(|error| format!("Could not launch Esteria: {error}"))?;

    if settings.minimize_on_play {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
        }
    }
    // The UI hides/minimizes the launcher before launching; bring it back once the game exits.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        if let Some(window) = app_clone.get_webview_window("main") {
            let hidden = !window.is_visible().unwrap_or(true);
            let minimized = window.is_minimized().unwrap_or(false);
            if hidden || minimized {
                reveal_main_window(&app_clone);
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn verify_installation(
    app: tauri::AppHandle,
    settings: LauncherSettings,
) -> Result<VerificationResult, String> {
    let root = game_root_from_settings(&settings, true)?;
    let client_installed = root.join("Wow.exe").is_file();
    if settings.manifest_source.trim().is_empty() {
        return Ok(VerificationResult {
            manifest_version: None,
            total_files: 0,
            checked_files: 0,
            missing_files: 0,
            corrupt_files: 0,
            up_to_date: client_installed,
            manifest_configured: false,
            client_installed,
            install_root: root.to_string_lossy().to_string(),
            issues: Vec::new(),
        });
    }

    let (manifest, _) = load_manifest(&settings.manifest_source).await?;
    let mut issues = Vec::new();
    let mut missing = 0;
    let mut corrupt = 0;
    let mut cache = load_hash_cache();
    let started = Instant::now();

    for (index, file) in manifest.files.iter().enumerate() {
        emit_patch_progress(
            &app,
            "checking",
            &file.path,
            index,
            manifest.files.len(),
            index as u64,
            manifest.files.len() as u64,
            started,
        );
        let relative = validate_relative_path(&file.path)?;
        let destination = root.join(relative);
        if !destination.is_file() {
            missing += 1;
            issues.push(FileIssue {
                path: file.path.clone(),
                kind: "missing".to_string(),
                detail: "File is missing.".to_string(),
            });
            continue;
        }

        if let Some(expected_size) = file.size {
            match tokio::fs::metadata(&destination).await {
                Ok(metadata) if metadata.len() != expected_size => {
                    corrupt += 1;
                    issues.push(FileIssue {
                        path: file.path.clone(),
                        kind: "size-mismatch".to_string(),
                        detail: format!("Expected {expected_size} bytes, found {}.", metadata.len()),
                    });
                    continue;
                }
                Err(error) => {
                    corrupt += 1;
                    issues.push(FileIssue {
                        path: file.path.clone(),
                        kind: "io-error".to_string(),
                        detail: error.to_string(),
                    });
                    continue;
                }
                _ => {}
            }
        }

        match cached_sha256(&root, &file.path, &destination, &mut cache).await {
            Ok(actual) if !actual.eq_ignore_ascii_case(file.sha256.trim()) => {
                corrupt += 1;
                issues.push(FileIssue {
                    path: file.path.clone(),
                    kind: "hash-mismatch".to_string(),
                    detail: "SHA-256 does not match the patch manifest.".to_string(),
                });
            }
            Err(error) => {
                corrupt += 1;
                issues.push(FileIssue {
                    path: file.path.clone(),
                    kind: "io-error".to_string(),
                    detail: error,
                });
            }
            _ => {}
        }
    }

    let _ = save_hash_cache(&cache);
    emit_patch_progress(
        &app,
        "checked",
        "",
        manifest.files.len(),
        manifest.files.len(),
        manifest.files.len() as u64,
        manifest.files.len() as u64,
        started,
    );

    Ok(VerificationResult {
        manifest_version: Some(manifest.version),
        total_files: manifest.files.len(),
        checked_files: manifest.files.len(),
        missing_files: missing,
        corrupt_files: corrupt,
        up_to_date: missing == 0 && corrupt == 0,
        manifest_configured: true,
        client_installed: root.join("Wow.exe").is_file(),
        install_root: root.to_string_lossy().to_string(),
        issues,
    })
}

async fn install_patch_file(
    app: &tauri::AppHandle,
    root: &Path,
    manifest: &PatchManifest,
    origin: &ResourceOrigin,
    file: &PatchFile,
    repair_position: usize,
    total_operations: usize,
    base_bytes: u64,
    bytes_total: u64,
    started: Instant,
    aggregate_bytes: Option<Arc<AtomicU64>>,
) -> Result<(u64, PathBuf), String> {
    let relative = validate_relative_path(&file.path)?;
    let destination = root.join(relative);
    let temp_destination = PathBuf::from(format!("{}.esteria-download", destination.to_string_lossy()));
    let source = patch_file_source(manifest, origin, file)?;

    emit_patch_progress(
        app,
        "downloading",
        &file.path,
        repair_position,
        total_operations,
        base_bytes,
        bytes_total,
        started,
    );

    let app_for_progress = app.clone();
    let file_name = file.path.clone();
    let progress_counter = aggregate_bytes.clone();
    let mut last_file_bytes = 0_u64;
    copy_or_download_resumable(source, &temp_destination, file.size, move |file_bytes| {
        let overall_bytes = if let Some(counter) = &progress_counter {
            let delta = file_bytes.saturating_sub(last_file_bytes);
            last_file_bytes = file_bytes;
            let previous = counter.fetch_add(delta, Ordering::Relaxed);
            base_bytes.saturating_add(previous.saturating_add(delta))
        } else {
            base_bytes.saturating_add(file_bytes)
        };
        emit_patch_progress(
            &app_for_progress,
            "downloading",
            &file_name,
            repair_position,
            total_operations,
            overall_bytes,
            bytes_total,
            started,
        );
    })
    .await?;

    let downloaded_hash = sha256_file(&temp_destination).await?;
    if !downloaded_hash.eq_ignore_ascii_case(file.sha256.trim()) {
        let _ = tokio::fs::remove_file(&temp_destination).await;
        return Err(format!("Downloaded file failed SHA-256 verification: {}", file.path));
    }

    let downloaded_size = tokio::fs::metadata(&temp_destination)
        .await
        .map_err(|error| format!("Could not inspect downloaded {}: {error}", file.path))?
        .len();
    if let Some(expected_size) = file.size {
        if downloaded_size != expected_size {
            return Err(format!(
                "Downloaded file has the wrong size for {}. Expected {expected_size}, got {downloaded_size}.",
                file.path
            ));
        }
    }

    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    if destination.exists() {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|error| format!("Could not replace {}: {error}", destination.display()))?;
    }
    tokio::fs::rename(&temp_destination, &destination)
        .await
        .map_err(|error| format!("Could not install {}: {error}", file.path))?;

    Ok((downloaded_size, destination))
}

#[tauri::command]
async fn repair_installation(
    app: tauri::AppHandle,
    settings: LauncherSettings,
) -> Result<RepairResult, String> {
    extras::PAUSED.store(false, Ordering::SeqCst);
    let root = game_root_from_settings(&settings, true)?;
    let (manifest, origin) = load_manifest(&settings.manifest_source).await?;
    let total = manifest.files.len();
    let mut cache = load_hash_cache();
    let mut repair_indexes = Vec::new();

    for (index, file) in manifest.files.iter().enumerate() {
        if !file_matches(&root, file, &mut cache).await? {
            repair_indexes.push(index);
        }
    }

    let mut bundled_indexes = HashSet::new();
    let mut active_bundles: Vec<&PatchBundle> = Vec::new();
    for bundle in &manifest.bundles {
        let affected: Vec<usize> = repair_indexes
            .iter()
            .copied()
            .filter(|index| path_is_under(&manifest.files[*index].path, &bundle.path).unwrap_or(false))
            .collect();
        if !affected.is_empty() {
            bundled_indexes.extend(affected);
            active_bundles.push(bundle);
        }
    }

    let remaining_indexes: Vec<usize> = repair_indexes
        .iter()
        .copied()
        .filter(|index| !bundled_indexes.contains(index))
        .collect();
    let mut bytes_total = active_bundles
        .iter()
        .fold(0_u64, |sum, bundle| sum.saturating_add(bundle.size));
    for index in &remaining_indexes {
        bytes_total = bytes_total.saturating_add(manifest.files[*index].size.unwrap_or(0));
    }

    let safety_margin = 256 * 1024 * 1024_u64;
    if bytes_total > 0 {
        if let Ok(available) = fs2::available_space(&root) {
            let required = bytes_total.saturating_add(safety_margin);
            if available < required {
                return Err(format!(
                    "Not enough free disk space. Update needs about {:.1} GB plus working space, but only {:.1} GB is available.",
                    bytes_total as f64 / 1_073_741_824.0,
                    available as f64 / 1_073_741_824.0
                ));
            }
        }
    }

    let mut repaired = 0;
    let skipped = total.saturating_sub(repair_indexes.len());
    let started = Instant::now();
    let mut completed_bytes = 0_u64;
    let (parallel_indexes, sequential_indexes): (Vec<usize>, Vec<usize>) = remaining_indexes
        .iter()
        .copied()
        .partition(|index| {
            manifest.files[*index]
                .size
                .map(|size| size <= PARALLEL_FILE_LIMIT)
                .unwrap_or(false)
        });
    let total_operations = active_bundles.len() + sequential_indexes.len() + parallel_indexes.len();

    for (bundle_position, bundle) in active_bundles.iter().enumerate() {
        let affected_count = repair_indexes
            .iter()
            .filter(|index| path_is_under(&manifest.files[**index].path, &bundle.path).unwrap_or(false))
            .count();
        install_patch_bundle(
            &app,
            &root,
            &manifest,
            &origin,
            bundle,
            &mut cache,
            completed_bytes,
            bytes_total,
            started,
            bundle_position,
            total_operations,
        )
        .await?;
        completed_bytes = completed_bytes.saturating_add(bundle.size);
        repaired += affected_count;
    }

    for (offset, index) in sequential_indexes.iter().copied().enumerate() {
        let repair_position = active_bundles.len() + offset;
        let file = &manifest.files[index];
        let (downloaded_size, destination) = install_patch_file(
            &app,
            &root,
            &manifest,
            &origin,
            file,
            repair_position,
            total_operations,
            completed_bytes,
            bytes_total,
            started,
            None,
        )
        .await?;
        completed_bytes = completed_bytes.saturating_add(downloaded_size);
        let _ = cached_sha256(&root, &file.path, &destination, &mut cache).await;
        repaired += 1;
    }

    if !parallel_indexes.is_empty() {
        let parallel_base = completed_bytes;
        let parallel_bytes = Arc::new(AtomicU64::new(0));
        let position_base = active_bundles.len() + sequential_indexes.len();
        let app_ref = &app;
        let root_ref = &root;
        let manifest_ref = &manifest;
        let origin_ref = &origin;
        let results = futures_util::stream::iter(
            parallel_indexes
                .iter()
                .copied()
                .enumerate()
                .map(|(offset, index)| {
                    let counter = parallel_bytes.clone();
                    async move {
                        let file = &manifest_ref.files[index];
                        let (downloaded_size, destination) = install_patch_file(
                            app_ref,
                            root_ref,
                            manifest_ref,
                            origin_ref,
                            file,
                            position_base + offset,
                            total_operations,
                            parallel_base,
                            bytes_total,
                            started,
                            Some(counter),
                        )
                        .await?;
                        Ok::<_, String>((index, downloaded_size, destination))
                    }
                }),
        )
        .buffer_unordered(PARALLEL_DOWNLOADS)
        .collect::<Vec<_>>()
        .await;

        for result in results {
            let (index, _downloaded_size, destination) = result?;
            let file = &manifest.files[index];
            let _ = cached_sha256(&root, &file.path, &destination, &mut cache).await;
            repaired += 1;
        }
        let _parallel_downloaded = parallel_bytes.load(Ordering::Relaxed);
    }

    save_hash_cache(&cache)?;
    emit_patch_progress(
        &app,
        "complete",
        "",
        total_operations,
        total_operations,
        bytes_total,
        bytes_total,
        started,
    );

    Ok(RepairResult {
        manifest_version: manifest.version,
        repaired_files: repaired,
        skipped_files: skipped,
        total_files: total,
        client_installed: root.join("Wow.exe").is_file(),
    })
}

#[tauri::command]
async fn list_addons(settings: LauncherSettings) -> Result<Vec<AddonView>, String> {
    if settings.addon_catalog_source.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root = game_root_from_settings(&settings, true)?;
    let (catalog, _) = load_addon_catalog(&settings.addon_catalog_source).await?;
    let state = load_managed_addons(&root);
    let mut result: Vec<AddonView> = catalog
        .addons
        .into_iter()
        .map(|addon| {
            let installed = state.addons.get(&addon.id);
            AddonView {
                id: addon.id,
                name: addon.name,
                version: addon.version.clone(),
                description: addon.description,
                author: addon.author,
                category: addon.category,
                homepage: addon.homepage,
                changelog: addon.changelog,
                required: addon.required,
                installed_version: installed.map(|value| value.version.clone()),
                installed: installed.is_some(),
                update_available: installed
                    .map(|value| value.version != addon.version)
                    .unwrap_or(false),
            }
        })
        .collect();
    result.sort_by(|a, b| b.required.cmp(&a.required).then_with(|| a.name.cmp(&b.name)));
    Ok(result)
}

#[tauri::command]
async fn install_addon(
    settings: LauncherSettings,
    addon_id: String,
) -> Result<AddonActionResult, String> {
    if settings.addon_catalog_source.trim().is_empty() {
        return Err("Configure an addon catalog first.".to_string());
    }
    let (catalog, origin) = load_addon_catalog(&settings.addon_catalog_source).await?;
    let addon = catalog
        .addons
        .iter()
        .find(|addon| addon.id == addon_id)
        .ok_or_else(|| "Addon was not found in the configured catalog.".to_string())?;
    install_addon_package(&settings, &catalog, &origin, addon).await
}

#[tauri::command]
async fn install_required_addons(settings: LauncherSettings) -> Result<Vec<AddonActionResult>, String> {
    if settings.addon_catalog_source.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root = game_root_from_settings(&settings, true)?;
    let (catalog, origin) = load_addon_catalog(&settings.addon_catalog_source).await?;
    let state = load_managed_addons(&root);
    let required: Vec<AddonPackage> = catalog
        .addons
        .iter()
        .filter(|addon| {
            addon.required
                && state
                    .addons
                    .get(&addon.id)
                    .map(|installed| installed.version != addon.version)
                    .unwrap_or(true)
        })
        .cloned()
        .collect();
    let mut results = Vec::new();
    for addon in required {
        results.push(install_addon_package(&settings, &catalog, &origin, &addon).await?);
    }
    Ok(results)
}

#[tauri::command]
async fn update_managed_addons(settings: LauncherSettings) -> Result<Vec<AddonActionResult>, String> {
    if settings.addon_catalog_source.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root = game_root_from_settings(&settings, true)?;
    let (catalog, origin) = load_addon_catalog(&settings.addon_catalog_source).await?;
    let state = load_managed_addons(&root);
    let updates: Vec<AddonPackage> = catalog
        .addons
        .iter()
        .filter(|addon| {
            state
                .addons
                .get(&addon.id)
                .map(|installed| installed.version != addon.version)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut results = Vec::new();
    for addon in updates {
        results.push(install_addon_package(&settings, &catalog, &origin, &addon).await?);
    }
    Ok(results)
}

#[tauri::command]
async fn remove_addon(
    settings: LauncherSettings,
    addon_id: String,
) -> Result<AddonActionResult, String> {
    let root = game_root_from_settings(&settings, true)?;
    if !settings.addon_catalog_source.trim().is_empty() {
        let (catalog, _) = load_addon_catalog(&settings.addon_catalog_source).await?;
        if let Some(addon) = catalog.addons.iter().find(|addon| addon.id == addon_id) {
            if addon.required {
                return Err(format!("{} is required by Esteria and cannot be removed.", addon.name));
            }
        }
    }

    let mut state = load_managed_addons(&root);
    let installed = state
        .addons
        .remove(&addon_id)
        .ok_or_else(|| "That addon is not installed by the launcher.".to_string())?;
    for folder in &installed.folders {
        let _ = tokio::fs::remove_dir_all(root.join("Interface").join("AddOns").join(folder)).await;
    }
    save_managed_addons(&root, &state)?;
    Ok(AddonActionResult {
        id: addon_id,
        name: installed.folders.join(", "),
        version: None,
        action: "removed".to_string(),
    })
}

#[tauri::command]
async fn check_realm(settings: LauncherSettings) -> RealmStatus {
    let host = settings.realm_host.trim().to_string();
    let port = settings.realm_port;
    let address = format!("{host}:{port}");
    match timeout(Duration::from_secs(2), TcpStream::connect(&address)).await {
        Ok(Ok(_)) => RealmStatus {
            online: true,
            host,
            port,
            detail: "Realm endpoint accepted a connection.".to_string(),
        },
        Ok(Err(error)) => RealmStatus {
            online: false,
            host,
            port,
            detail: error.to_string(),
        },
        Err(_) => RealmStatus {
            online: false,
            host,
            port,
            detail: "Connection timed out.".to_string(),
        },
    }
}

#[tauri::command]
async fn fetch_news(settings: LauncherSettings) -> Result<serde_json::Value, String> {
    if settings.news_source.trim().is_empty() {
        return Ok(serde_json::json!({ "schemaVersion": 1, "items": [] }));
    }
    load_json_source(&settings.news_source).await
}

/// Patch notes are a Markdown file on the CDN that the server admin edits by hand.
#[tauri::command]
async fn fetch_patch_notes(settings: LauncherSettings) -> Result<String, String> {
    if settings.patch_notes_source.trim().is_empty() {
        return Ok(String::new());
    }
    Ok(load_text_source(&settings.patch_notes_source).await?.0)
}

#[tauri::command]
async fn fetch_server_status(settings: LauncherSettings) -> Result<serde_json::Value, String> {
    if settings.status_source.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    load_json_source(&settings.status_source).await
}

#[tauri::command]
async fn fetch_social_snapshot(settings: LauncherSettings) -> Result<serde_json::Value, String> {
    if settings.social_source.trim().is_empty() {
        return Ok(serde_json::json!({ "schemaVersion": 1, "players": [] }));
    }
    load_json_source(&settings.social_source).await
}

#[tauri::command]
async fn fetch_armory(settings: LauncherSettings, query: Option<String>) -> Result<serde_json::Value, String> {
    if settings.armory_source.trim().is_empty() {
        return Ok(serde_json::json!({ "schemaVersion": 1, "characters": [] }));
    }
    let query = query.unwrap_or_default();
    load_json_source_query(&settings.armory_source, &[("q", query.as_str())]).await
}

#[tauri::command]
async fn fetch_database(
    settings: LauncherSettings,
    query: Option<String>,
    entry_type: Option<String>,
) -> Result<serde_json::Value, String> {
    if settings.database_source.trim().is_empty() {
        return Ok(serde_json::json!({ "schemaVersion": 1, "entries": [] }));
    }
    let query = query.unwrap_or_default();
    let entry_type = entry_type.unwrap_or_default();
    load_json_source_query(
        &settings.database_source,
        &[("q", query.as_str()), ("type", entry_type.as_str())],
    )
    .await
}

#[tauri::command]
fn get_social_state() -> SocialState {
    load_social_state()
}

#[tauri::command]
fn save_player_profile(mut profile: PlayerProfile) -> Result<SocialState, String> {
    profile.display_name = profile.display_name.trim().chars().take(32).collect();
    if profile.display_name.is_empty() {
        profile.display_name = default_player_name();
    }
    profile.status_message = profile.status_message.trim().chars().take(120).collect();
    profile.bio = profile.bio.trim().chars().take(400).collect();
    profile.favorite_character = profile.favorite_character.trim().chars().take(32).collect();
    if !matches!(profile.presence.as_str(), "online" | "away" | "dnd" | "offline") {
        profile.presence = default_presence();
    }
    let mut state = load_social_state();
    state.profile = profile;
    save_social_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn save_social_preferences(preferences: SocialPreferences) -> Result<SocialState, String> {
    let mut state = load_social_state();
    state.preferences = preferences;
    save_social_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn add_friend(name: String) -> Result<SocialState, String> {
    let clean: String = name.trim().chars().take(32).collect();
    if clean.is_empty() {
        return Err("Enter a player or character name.".to_string());
    }
    let mut state = load_social_state();
    if state.friends.iter().any(|friend| friend.name.eq_ignore_ascii_case(&clean)) {
        return Err(format!("{clean} is already in your friends list."));
    }
    state.friends.push(FriendEntry { name: clean, note: String::new(), favorite: false, added_at: now_millis() });
    save_social_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn remove_friend(name: String) -> Result<SocialState, String> {
    let mut state = load_social_state();
    state.friends.retain(|friend| !friend.name.eq_ignore_ascii_case(name.trim()));
    state.conversations.retain(|conversation| !conversation.friend_name.eq_ignore_ascii_case(name.trim()));
    save_social_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn send_chat_message(friend_name: String, body: String) -> Result<SocialState, String> {
    let friend_name: String = friend_name.trim().chars().take(32).collect();
    let body: String = body.trim().chars().take(1000).collect();
    if friend_name.is_empty() || body.is_empty() {
        return Err("Choose a friend and enter a message.".to_string());
    }
    let mut state = load_social_state();
    if !state.friends.iter().any(|friend| friend.name.eq_ignore_ascii_case(&friend_name)) {
        return Err("Messages can only be sent to saved friends.".to_string());
    }
    let sender = state.profile.display_name.clone();
    let message = ChatMessage {
        id: format!("{}-{}", now_millis(), state.conversations.len()),
        sender,
        body,
        sent_at: now_millis(),
        read: true,
    };
    if let Some(conversation) = state.conversations.iter_mut().find(|conversation| conversation.friend_name.eq_ignore_ascii_case(&friend_name)) {
        conversation.messages.push(message);
    } else {
        state.conversations.push(Conversation { friend_name: friend_name.clone(), messages: vec![message] });
    }
    save_social_state(&state)?;
    Ok(state)
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    name: String,
    mime_type: String,
    data_base64: String,
}

/// Remembers the Esteria account session so presence, friends, chat, and the
/// profile picture survive a launcher restart. The token is the only secret.
#[tauri::command]
fn save_account_session(session: AccountSession) -> Result<SocialState, String> {
    let token = session.token.trim().to_string();
    if token.is_empty() {
        return Err("The Esteria account session did not include a token.".to_string());
    }
    let username = session.username.trim().to_lowercase().chars().take(20).collect::<String>();
    if username.is_empty() {
        return Err("The Esteria account session did not include an account name.".to_string());
    }
    let mut display_name: String = session.display_name.trim().chars().take(32).collect();
    if display_name.is_empty() {
        display_name = username.clone();
    }
    let mut state = load_social_state();
    state.account = Some(AccountSession {
        token,
        username,
        display_name,
        api_base: session.api_base.trim().trim_end_matches('/').to_string(),
        logged_in_at: now_millis(),
    });
    save_social_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn clear_account_session() -> Result<SocialState, String> {
    let mut state = load_social_state();
    state.account = None;
    save_social_state(&state)?;
    Ok(state)
}

struct UploadKind {
    title: &'static str,
    filters: &'static [&'static str],
    error: &'static str,
    limit: u64,
}

/// Opens a picker, checks the file is a real image or video, and hands the bytes to
/// the webview so the launcher keeps a single HTTP path for account requests.
#[tauri::command]
fn pick_upload(kind: String) -> Result<Option<PickedFile>, String> {
    let spec = match kind.as_str() {
        "avatar" => UploadKind {
            title: "Choose an Esteria profile picture",
            filters: &["png", "jpg", "jpeg", "webp", "gif"],
            error: "Profile pictures must be PNG, JPEG, WebP, or GIF images.",
            limit: 8 * 1024 * 1024,
        },
        "header" => UploadKind {
            title: "Choose an Esteria profile header",
            filters: &["png", "jpg", "jpeg", "webp", "gif"],
            error: "Profile headers must be PNG, JPEG, WebP, or GIF images.",
            limit: 16 * 1024 * 1024,
        },
        _ => UploadKind {
            title: "Choose a picture or video to share",
            filters: &["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm"],
            error: "Posts accept PNG, JPEG, WebP, GIF, MP4, or WebM files.",
            limit: 32 * 1024 * 1024,
        },
    };
    let selected = rfd::FileDialog::new()
        .set_title(spec.title)
        .add_filter("Supported files", spec.filters)
        .pick_file();
    let Some(path) = selected else {
        return Ok(None);
    };
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read that file: {error}"))?;
    if metadata.len() > spec.limit {
        return Err(format!(
            "That file is {} MB. The limit is {} MB.",
            (metadata.len() + 1024 * 1024 - 1) / (1024 * 1024),
            spec.limit / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not read that file: {error}"))?;
    let mime_type = if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) {
        "image/webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() > 12 && bytes.get(4..8) == Some(b"ftyp".as_slice()) {
        "video/mp4"
    } else if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        "video/webm"
    } else {
        return Err(spec.error.to_string());
    };
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".to_string());
    let engine = base64::engine::general_purpose::STANDARD;
    Ok(Some(PickedFile {
        name,
        mime_type: mime_type.to_string(),
        data_base64: base64::Engine::encode(&engine, &bytes),
    }))
}
#[tauri::command]
fn open_client_subfolder(settings: LauncherSettings, folder: String) -> Result<(), String> {
    let allowed = ["Logs", "Screenshots", "Interface\\AddOns", "WTF"];
    if !allowed.iter().any(|candidate| candidate.eq_ignore_ascii_case(folder.trim())) {
        return Err("That client folder is not exposed through Launcher Tools.".to_string());
    }
    let root = game_root_from_settings(&settings, true)?;
    let target = root.join(folder.trim());
    fs::create_dir_all(&target).map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    Command::new("explorer").arg(&target).spawn().map_err(|error| format!("Could not open {}: {error}", target.display()))?;
    Ok(())
}

#[tauri::command]
fn clear_launcher_cache() -> Result<(), String> {
    let path = hash_cache_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("Could not clear launcher cache: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn launcher_diagnostics(settings: LauncherSettings) -> serde_json::Value {
    let root = normalize_install_root(&settings.game_path).ok();
    serde_json::json!({
        "launcherVersion": env!("CARGO_PKG_VERSION"),
        "channel": settings.channel,
        "installRoot": root.as_ref().map(|path| path.to_string_lossy().to_string()),
        "wowExists": root.as_ref().map(|path| path.join("Wow.exe").is_file()).unwrap_or(false),
        "settingsPath": settings_path().ok().map(|path| path.to_string_lossy().to_string()),
        "hashCachePath": hash_cache_path().ok().map(|path| path.to_string_lossy().to_string()),
        "socialStatePath": social_state_path().ok().map(|path| path.to_string_lossy().to_string()),
        "manifestSource": settings.manifest_source,
        "addonCatalogSource": settings.addon_catalog_source
    })
}

#[tauri::command]
fn open_install_directory(settings: LauncherSettings) -> Result<(), String> {
    let root = game_root_from_settings(&settings, false)?;
    if !root.exists() {
        return Err("The selected Esteria install folder does not exist yet.".to_string());
    }
    Command::new("explorer")
        .arg(&root)
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", root.display()))?;
    Ok(())
}

#[tauri::command]
async fn clear_wdb(settings: LauncherSettings) -> Result<bool, String> {
    let root = game_root_from_settings(&settings, false)?;
    let wdb = root.join("WDB");
    if !wdb.exists() {
        return Ok(false);
    }
    tokio::fs::remove_dir_all(&wdb)
        .await
        .map_err(|error| format!("Could not clear {}: {error}", wdb.display()))?;
    Ok(true)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http:// and https:// links can be opened.".to_string());
    }
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("Could not open the link: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn check_launcher_update(app: tauri::AppHandle) -> Result<Option<LauncherUpdateInfo>, String> {
    let updater = app.updater().map_err(|error| format!("Launcher updater is unavailable: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Could not check for a launcher update: {error}"))?;
    Ok(update.map(|value| LauncherUpdateInfo {
        version: value.version,
        current_version: value.current_version,
        notes: None,
        date: None,
    }))
}

#[tauri::command]
async fn install_launcher_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|error| format!("Launcher updater is unavailable: {error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("Could not check for a launcher update: {error}"))?
    else {
        return Err("No newer launcher release is available.".to_string());
    };

    let progress_app = app.clone();
    let finished_app = app.clone();
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let percent = content_length.and_then(|total| {
                    if total == 0 {
                        None
                    } else {
                        Some(((downloaded.saturating_mul(100) / total).min(100)) as u8)
                    }
                });
                let _ = progress_app.emit(
                    "launcher-update-progress",
                    LauncherUpdateProgress {
                        downloaded,
                        total: content_length,
                        percent,
                    },
                );
            },
            move || {
                let _ = finished_app.emit(
                    "launcher-update-progress",
                    LauncherUpdateProgress {
                        downloaded: 1,
                        total: Some(1),
                        percent: Some(100),
                    },
                );
            },
        )
        .await
        .map_err(|error| format!("Could not install the launcher update: {error}"))?;
    Ok(())
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        settings_path: settings_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unavailable".to_string()),
        detected_game_path: detect_game_path_internal().map(|path| path.to_string_lossy().to_string()),
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Set once the user really wants out, so the close handler stops intercepting.
static EXITING: AtomicBool = AtomicBool::new(false);
/// A conversation the chat window should open the next time it is shown or focused.
static PENDING_CHAT: Mutex<Option<String>> = Mutex::new(None);

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Esteria Launcher", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Esteria Launcher", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("esteria-tray")
        .tooltip("Esteria Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => reveal_main_window(app),
            "quit" => {
                EXITING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if EXITING.load(Ordering::SeqCst) {
        return;
    }
    match window.label() {
        // The chat popout is hidden rather than destroyed so it can be reopened instantly.
        "chat" => {
            api.prevent_close();
            let _ = window.hide();
        }
        // The launcher asks the interface what to do instead of disappearing.
        "main" => {
            api.prevent_close();
            let _ = window.emit("launcher-close-requested", ());
        }
        _ => {}
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    reveal_main_window(&app);
}

#[tauri::command]
fn quit_launcher(app: tauri::AppHandle) {
    EXITING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is not available.".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is not available.".to_string())?;
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_play_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is not available.".to_string())?;
    match normalize_window_action(&action, &["minimize", "tray", "keep"], "keep").as_str() {
        "minimize" => window.minimize().map_err(|error| error.to_string())?,
        "tray" => window.hide().map_err(|error| error.to_string())?,
        _ => {}
    }
    Ok(())
}

/// Remembers which conversation the chat window should surface next.
#[tauri::command]
fn set_pending_chat(friend: String) {
    if let Ok(mut guard) = PENDING_CHAT.lock() {
        let trimmed = friend.trim().to_string();
        *guard = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
}

#[tauri::command]
fn take_pending_chat() -> Option<String> {
    PENDING_CHAT.lock().ok().and_then(|mut guard| guard.take())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Err(error) = build_tray(app.handle()) {
                eprintln!("Could not create the tray icon: {error}");
            }
            Ok(())
        })
        .on_window_event(handle_window_event)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            detect_game_path,
            choose_install_directory,
            launch_game,
            verify_installation,
            repair_installation,
            extras::pause_download,
            extras::install_from_source,
            extras::open_torrent_link,
            extras::list_screenshots,
            extras::read_screenshot,
            extras::load_screenshot_meta,
            extras::save_screenshot_meta,
            extras::rename_screenshot,
            extras::set_discord_presence,
            extras::character_portraits,
            list_addons,
            install_addon,
            install_required_addons,
            update_managed_addons,
            remove_addon,
            check_realm,
            fetch_news,
            fetch_server_status,
            fetch_social_snapshot,
            fetch_armory,
            fetch_database,
            get_social_state,
            save_player_profile,
            save_social_preferences,
            add_friend,
            remove_friend,
            send_chat_message,
            save_account_session,
            clear_account_session,
            pick_upload,
            show_main_window,
            quit_launcher,
            hide_main_window,
            minimize_main_window,
            apply_play_action,
            set_pending_chat,
            take_pending_chat,
            open_install_directory,
            open_client_subfolder,
            clear_wdb,
            clear_launcher_cache,
            launcher_diagnostics,
            open_external_url,
            fetch_patch_notes,
            check_launcher_update,
            install_launcher_update,
            runtime_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running Esteria Launcher");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn manifest_paths_reject_parent_traversal() {
        assert!(validate_relative_path("Data/patch-E.mpq").is_ok());
        assert!(validate_relative_path("../Wow.exe").is_err());
        assert!(validate_relative_path("Data/../../Windows/system.ini").is_err());
        assert!(validate_relative_path("C:\\Windows\\system.ini").is_err());
    }

    #[test]
    fn bundle_update_preserves_excluded_files_and_keeps_verified_replacements() {
        let temp = tempdir().expect("tempdir");
        let current = temp.path().join("current");
        let staged = temp.path().join("staged");
        fs::create_dir_all(current.join("nested")).unwrap();
        fs::create_dir_all(&staged).unwrap();
        fs::write(current.join("managed.txt"), b"old").unwrap();
        fs::write(current.join("local.ini"), b"player settings").unwrap();
        fs::write(current.join("nested/custom.txt"), b"player addition").unwrap();
        fs::write(staged.join("managed.txt"), b"verified update").unwrap();

        preserve_unmanaged_bundle_files(&current, &staged).unwrap();
        assert_eq!(fs::read(staged.join("managed.txt")).unwrap(), b"verified update");
        assert_eq!(fs::read(staged.join("local.ini")).unwrap(), b"player settings");
        assert_eq!(fs::read(staged.join("nested/custom.txt")).unwrap(), b"player addition");
        assert_eq!(fs::read(current.join("managed.txt")).unwrap(), b"old");

        fs::create_dir_all(staged.join("conflict")).unwrap();
        fs::write(current.join("conflict"), b"must not lose this").unwrap();
        assert!(preserve_unmanaged_bundle_files(&current, &staged).is_err());
        assert_eq!(fs::read(current.join("conflict")).unwrap(), b"must not lose this");
        assert!(preserve_unmanaged_bundle_files(&temp.path().join("missing"), &staged).is_ok());
    }

    #[test]
    fn install_path_accepts_folder_or_legacy_wow_exe() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("Esteria");
        fs::create_dir_all(&root).expect("create install root");
        let wow = root.join("Wow.exe");
        fs::write(&wow, b"fixture").expect("write wow");

        assert_eq!(normalize_install_root(root.to_string_lossy().as_ref()).unwrap(), root);
        assert_eq!(normalize_install_root(wow.to_string_lossy().as_ref()).unwrap(), root);
    }

    #[test]
    fn manifest_source_understands_remote_and_local_inputs() {
        match parse_resource_origin("https://patch.example.test/manifest.json").expect("remote") {
            ResourceOrigin::Remote(url) => assert_eq!(url.scheme(), "https"),
            _ => panic!("expected remote"),
        }
        match parse_resource_origin("C:\\Esteria\\manifest.json").expect("local") {
            ResourceOrigin::Local(path) => assert!(path.ends_with("manifest.json")),
            _ => panic!("expected local"),
        }
    }

    #[tokio::test]
    async fn local_patch_payload_can_be_loaded_copied_and_verified() {
        let temp = tempdir().expect("tempdir");
        let payload = temp.path().join("payload");
        let client = temp.path().join("client");
        fs::create_dir_all(payload.join("Data")).expect("payload dir");
        fs::create_dir_all(&client).expect("client dir");

        let bytes = b"esteria patch fixture";
        let source_file = payload.join("Data").join("patch-E.mpq");
        fs::write(&source_file, bytes).expect("write source");
        let hash = sha256_file(&source_file).await.expect("hash source");
        let manifest_path = payload.join("manifest.json");
        let manifest_json = serde_json::json!({
            "version": "test-1",
            "files": [{
                "path": "Data/patch-E.mpq",
                "url": "Data/patch-E.mpq",
                "sha256": hash,
                "size": bytes.len()
            }]
        });
        fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest_json).unwrap())
            .expect("write manifest");

        let (manifest, origin) = load_manifest(manifest_path.to_string_lossy().as_ref())
            .await
            .expect("load manifest");
        let file = &manifest.files[0];
        let destination = client.join("Data").join("patch-E.mpq.esteria-download");
        let source = patch_file_source(&manifest, &origin, file).expect("resolve source");
        copy_or_download_resumable(source, &destination, file.size, |_| {})
            .await
            .expect("copy payload");
        let final_path = client.join("Data").join("patch-E.mpq");
        fs::rename(&destination, &final_path).expect("install payload");
        let mut cache = HashMap::new();
        assert!(file_matches(&client, file, &mut cache).await.expect("verify copied file"));
    }

    #[tokio::test]
    async fn remote_download_resumes_with_http_range() {
        let temp = tempdir().expect("tempdir");
        let destination = temp.path().join("payload.part");
        let payload = b"hello esterian world".to_vec();
        fs::write(&destination, &payload[..5]).expect("seed partial file");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("server address");
        let expected_tail = payload[5..].to_vec();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = vec![0_u8; 4096];
            let read = socket.read(&mut request).await.expect("read request");
            let request_text = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request_text.contains("range: bytes=5-"));
            let header = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 5-{}/{}\r\nConnection: close\r\n\r\n",
                expected_tail.len(),
                5 + expected_tail.len() - 1,
                5 + expected_tail.len()
            );
            socket.write_all(header.as_bytes()).await.expect("write headers");
            socket.write_all(&expected_tail).await.expect("write body");
        });

        let url = Url::parse(&format!("http://{address}/payload.bin")).expect("url");
        copy_or_download_resumable(
            DownloadSource::Remote(url),
            &destination,
            Some(payload.len() as u64),
            |_| {},
        )
        .await
        .expect("resume download");
        server.await.expect("server task");
        assert_eq!(fs::read(&destination).expect("read result"), payload);
    }

    #[test]
    fn config_wtf_updates_server_values_without_erasing_player_settings() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("Esteria");
        fs::create_dir_all(root.join("WTF")).expect("create WTF");
        fs::write(
            root.join("WTF").join("Config.wtf"),
            "SET gxWindow \"1\"\r\nSET realmlist \"old.example\"\r\nSET patchlist \"old.example\"\r\n",
        )
        .expect("write config");
        let settings = LauncherSettings {
            game_path: root.to_string_lossy().to_string(),
            realm_host: "realm.esteria.test".to_string(),
            patch_list: "patch.esteria.test".to_string(),
            ..LauncherSettings::default()
        };
        update_config_wtf(&settings).expect("update config");
        let config = fs::read_to_string(root.join("WTF").join("Config.wtf")).expect("read config");
        assert!(config.contains("SET gxWindow \"1\""));
        assert!(config.contains("SET realmlist \"realm.esteria.test\""));
        assert!(config.contains("SET patchlist \"patch.esteria.test\""));
        assert!(!config.contains("old.example"));
    }

    #[test]
    fn zip_extraction_rejects_traversal_and_extracts_normal_files() {
        let temp = tempdir().expect("tempdir");
        let zip_path = temp.path().join("addon.zip");
        {
            let file = fs::File::create(&zip_path).expect("zip file");
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("ExampleAddon/ExampleAddon.toc", options)
                .expect("start zip file");
            zip.write_all(b"## Interface: 30300\n").expect("write zip file");
            zip.finish().expect("finish zip");
        }
        let out = temp.path().join("out");
        extract_zip_safely(&zip_path, &out).expect("extract safe zip");
        assert!(out.join("ExampleAddon").join("ExampleAddon.toc").is_file());

        let unsafe_zip = temp.path().join("unsafe.zip");
        {
            let file = fs::File::create(&unsafe_zip).expect("unsafe zip file");
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("../escape.txt", options).expect("start unsafe entry");
            zip.write_all(b"nope").expect("write unsafe entry");
            zip.finish().expect("finish unsafe zip");
        }
        assert!(extract_zip_safely(&unsafe_zip, &temp.path().join("unsafe-out")).is_err());
        assert!(!temp.path().join("escape.txt").exists());
    }
}
