# Esteria Launcher

Battle.net-inspired desktop launcher for Esteria, built with Tauri 2, Rust, HTML, CSS, and JavaScript.

## Current feature set

### Client delivery and repair

- Live/PTR channel selector persists per launcher install and switches channel-aware manifest URLs automatically
- Installs a complete Esteria client into an empty folder from a CDN manifest
- Existing `Wow.exe` installs are auto-detected and can be adopted
- SHA-256 verification for every managed client file
- Persistent hash cache so unchanged large MPQs do not need to be re-hashed every launch
- Missing/corrupt file detection
- Resumable HTTP downloads using `.esteria-download` partial files and HTTP Range requests
- Download stall timeout
- Byte progress, transfer speed, and ETA in the launcher UI
- Disk-space preflight before a large install/update
- Downloads are verified before replacing installed files
- Large extracted directories can be delivered as verified ZIP bundles instead of thousands of individual HTTP requests
- Bundle extraction uses staging + backup directories and verifies extracted files before the live directory is swapped
- Up to four smaller files can download in parallel while large payloads and bundles remain sequential
- Local manifests and local payloads remain supported for operator testing

### Game launch

- Launches `Wow.exe` with the client directory as its working directory
- Prevents a second WoW process from being started when `Wow.exe` is already running
- Writes Esteria `realmlist` and optional `patchlist` values into `WTF/Config.wtf` while preserving unrelated player settings
- Optional WDB cleanup before launch
- Optional minimize-to-taskbar while WoW is running, then restores the launcher when the game exits
- Realm reachability check over TCP

### Add-on manager

- Reads a launcher-managed add-on catalog from HTTP/HTTPS or a local JSON file
- Installs versioned ZIP packages into `Interface\AddOns`
- SHA-256 and optional file-size verification before extraction
- ZIP path traversal protection
- Install, reinstall, update, and remove actions
- Required add-ons can be marked non-removable and installed in one action
- Installed launcher-managed add-ons can auto-update when their catalog version changes
- Optional catalog metadata supports author, category, homepage, and changelog fields
- Managed add-on state is stored under the selected client's `.launcher` directory

### Social, Armory, Database, and launcher tools

- Esteria accounts: unique account name and password, with a signed-in identity that follows the player between devices
- Server-backed presence, player discovery, friend requests, one-to-one chat, and per-player profile pictures
- Chat lives in its own draggable, resizable window, with distinct incoming and outgoing message sounds
- Friend profile cards show bio, header image, avatar, presence, and status, with Send message, Nickname, Favorite, and Remove friend actions; right-clicking a friend opens the same actions as a menu
- Group chats with up to 20 friends, created from the chat window
- Community tab: post updates, screenshots, or clips that only your friends can see
- Animated GIF avatars and animated profile headers
- Local-only profile, friends, and chat stay available when no account is signed in
- Local player profile with Online, Away, Do Not Disturb, and Appear Offline presence modes
- Persistent local friends list, social preferences, one-to-one chat history, search, and unread state
- Live friend presence can merge data from `/api/v2/social.json` and the server-status character list
- Armory search reads sanitized character snapshots from `/api/v2/armory/characters.json` and renders character, guild, progression, and equipment data
- World Database searches `/api/v2/database/index.json` by name, ID, and content type
- Armory equipment can jump directly into matching World Database items
- Launcher Tools includes verify, repair, install-folder/AddOns/WTF/Logs/Screenshots shortcuts, WDB cleanup, hash-cache cleanup, updater checks, and diagnostics
- CDN-backed news cards through `/api/v2/news.json`
- CDN-backed realm/player/build status through `/api/v2/status`
- Signed Tauri self-update checks and passive Windows installation

Players can sign in with an Esteria account from the profile dialog. Once signed in, presence, friends, chat, and the profile picture are served by the account API described below and follow the player to any PC. Signed out, the launcher keeps the original local-only behavior.

## Recommended CDN backend

The existing server in:

```text
R:\Users\Zach\Documents\GitHub\EsteriaWoW\Launcher-src\server
```

has been extended to support this launcher without breaking the old Electron launcher.

The new endpoints are:

```text
GET /api/v2/build-status?channel=live
GET /api/v2/client/<channel>/manifest.json
GET /api/v2/addons/catalog.json
GET /api/v2/news.json
GET /api/v2/status
GET /api/v2/social.json
GET /api/v2/armory/characters.json?q=<search>
GET /api/v2/database/index.json?q=<search>&type=<type>
GET /client/<channel>/<relative-file-path>
GET /addons/<package-file>
GET /launcher-updates/latest.json
```

The old launcher endpoints remain available alongside them.

### Esteria account and social service

The same service hosts the launcher account API. It keeps accounts, friend links, and chat messages in a small JSON directory and stores uploaded profile pictures next to them, so it needs one writable directory in addition to the CDN tree:

```text
POST   /api/v2/account/register        { username, password, displayName? }
POST   /api/v2/account/login           { username, password }
POST   /api/v2/account/logout
GET    /api/v2/account/me
POST   /api/v2/account/profile         { displayName?, statusMessage?, presence? }
PUT    /api/v2/account/avatar          { mimeType, dataBase64 }
DELETE /api/v2/account/avatar
GET    /avatars/<account-id>.<png|jpg|webp|gif>?v=<version>
PUT    /api/v2/account/header         { mimeType, dataBase64 }
DELETE /api/v2/account/header
GET    /headers/<account-id>.<ext>?v=<version>
GET    /api/v2/social/profiles/<username>
POST   /api/v2/social/friends/<username>   { nickname?, favorite? }
GET    /api/v2/social/groups
POST   /api/v2/social/groups               { name, members: [username] }
GET    /api/v2/social/groups/<id>/messages?since=<messageId>
POST   /api/v2/social/groups/<id>/messages { body }
DELETE /api/v2/social/groups/<id>
GET    /api/v2/social/posts?since=<postId>
POST   /api/v2/social/posts                { body, mimeType?, dataBase64? }
DELETE /api/v2/social/posts/<id>
GET    /media/<post-id>.<png|jpg|webp|gif|mp4|webm>
GET    /api/v2/social/feed
POST   /api/v2/social/heartbeat        { presence?, statusMessage?, displayName? }
GET    /api/v2/social/discover?q=<name>
POST   /api/v2/social/friends          { username }
POST   /api/v2/social/friends/accept   { username }
DELETE /api/v2/social/friends/<username>
GET    /api/v2/social/messages?with=<username>&since=<messageId>
POST   /api/v2/social/messages         { to, body }
```

Passwords are stored as scrypt hashes. Login and registration return a bearer token, and every other account or social route expects it in an `Authorization: Bearer <token>` header. Presence is derived from heartbeats, so a player who stops heartbeating fades to Away and then Offline. Profile pictures accept PNG, JPEG, or WebP up to 2 MB and are validated by magic bytes.

Start the CDN service with the account store pointed at a writable directory:

```powershell
$env:SOCIAL_DATA_DIR = 'G:\EsteriaCDN\social'
$env:SOCIAL_PUBLIC_BASE_URL = 'https://cdn.example.com'
```

Run the end-to-end account check with:

```powershell
Set-Location R:\Users\Zach\Documents\GitHub\EsteriaWoW\Launcher-src\server
npm run selftest:social
```

Put the same host behind HTTPS before inviting players. Account names and passwords travel in the request body, so plain HTTP exposes them to anyone on the path.

### CDN staging layout

A practical server layout is:

```text
G:\EsteriaCDN\
  client\
    live\
      Wow.exe
      Data\
      Interface\
      Extensions\
      ...
  addons\
    catalog.json
    Questie\
      1.2.0.zip
    AtlasLoot\
      6.05.zip
  launcher-updates\
  news.json
  status.json
  social.json
  armory.json
  database-index.json
  backups\
```

Start the existing CDN service with:

```cmd
R:\Users\Zach\Documents\GitHub\EsteriaWoW\Launcher-src\server\start-cdn.cmd
```

`server\start-cdn.cmd` defaults `ESTERIA_CDN_ROOT` to `G:\EsteriaCDN`, the CDN path on the machine that runs the service, and derives the channel, add-on, update, and account paths from it. Set `ESTERIA_CDN_ROOT` when the CDN lives elsewhere, such as the `Y:` network mount on a workstation. Append `/check` to print the resolved paths without starting anything. The manual equivalent sets the same variables:

```powershell
Set-Location R:\Users\Zach\Documents\GitHub\EsteriaWoW\Launcher-src\server
$env:CLIENT_ROOT_DIR = 'G:\EsteriaCDN\client'
$env:CLIENT_CHANNELS = 'live,ptr'
$env:ADDONS_DIR = 'G:\EsteriaCDN\addons'
$env:LAUNCHER_UPDATES_DIR = 'G:\EsteriaCDN\launcher-updates'
$env:NEWS_FILE = 'G:\EsteriaCDN\news.json'
$env:STATUS_FILE = 'G:\EsteriaCDN\status.json'
$env:SOCIAL_FILE = 'G:\EsteriaCDN\social.json'
$env:ARMORY_FILE = 'G:\EsteriaCDN\armory.json'
$env:DATABASE_FILE = 'G:\EsteriaCDN\database-index.json'
$env:SOCIAL_DATA_DIR = 'G:\EsteriaCDN\social'
npm run dev
```

The server builds `manifest-v2.json` using SHA-256. It excludes player-generated state such as Logs, Screenshots, WDB, account WTF data, and `.launcher` state.

For large extracted directories, the server automatically recognizes the two bundle pairs already used by the old launcher when both the expanded directory and ZIP exist:

```text
Data\Patch-Housing.MPQ       + Data\Patch-Housing.MPQ.zip
Data\patch-K.mpq             + Data\patch-K.mpq.zip
```

You can override or extend that list with `G:\EsteriaCDN\client\live\.delivery-bundles.json`:

```json
[
  {
    "path": "Data/Patch-Housing.MPQ",
    "archive": "Data/Patch-Housing.MPQ.zip"
  }
]
```

The expanded directory remains authoritative for per-file SHA-256 verification. The ZIP is only the transport bundle and is not installed into the player's client.

For public distribution, put the Node service behind HTTPS with Caddy, IIS, nginx, or another reverse proxy. Do not expose account data or a player's live profile as the CDN source tree.

## Launcher configuration

The current source defaults to the same Esteria host used by the existing launcher: `planetkai.hopto.org:7384`, with `planetkai.hopto.org` as the realm and patch-list host. Those defaults can still be overridden at build time or in launcher settings. The v2 CDN routes must be deployed/restarted on that server before the new launcher can use them.

Open the gear next to Play and configure:

```text
Esteria install folder
C:\Games\Esteria

Client manifest
https://cdn.example.com/api/v2/client/live/manifest.json

Add-on catalog
https://cdn.example.com/api/v2/addons/catalog.json

Realm host
logon.example.com

Realm port
3724

Patch list
patch.example.com
```

The install folder can be empty. After verification the button becomes **Install** when a complete client needs to be delivered, **Update** when an existing client needs repair, and **Play** when `Wow.exe` and all managed files are ready.

## Client manifest format

The CDN server generates this automatically. The launcher also accepts hand-authored manifests for testing:

```json
{
  "schemaVersion": 2,
  "channel": "live",
  "version": "2026.10.07.1",
  "files": [
    {
      "path": "Wow.exe",
      "sha256": "<64-character SHA-256>",
      "size": 12345678,
      "url": "/client/live/Wow.exe"
    },
    {
      "path": "Data/patch-E.mpq",
      "sha256": "<64-character SHA-256>",
      "size": 1234567890,
      "url": "/client/live/Data/patch-E.mpq"
    }
  ]
}
```

Parent traversal and absolute client paths are rejected.

## Add-on catalog format

Place `catalog.json` in the directory configured as `ADDONS_DIR`:

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://cdn.example.com/addons/",
  "addons": [
    {
      "id": "questie",
      "name": "Questie",
      "version": "1.2.0",
      "description": "Quest tracking for Esteria.",
      "packageUrl": "Questie/1.2.0.zip",
      "sha256": "<64-character SHA-256>",
      "size": 4839210,
      "folders": ["Questie"],
      "required": false
    }
  ]
}
```

Each ZIP should contain its declared add-on folder at the ZIP root:

```text
Questie-1.2.0.zip
  Questie\
    Questie.toc
    ...
```

Multiple folders are supported for add-ons that ship companion modules:

```json
"folders": ["Auctionator", "Auctionator_Config"]
```

Required add-ons should use:

```json
"required": true
```

They cannot be removed through the launcher and can be installed together with **Install required**.

## Build-time defaults

Player builds can ship with CDN fields already populated so users never need to see CDN URLs.

Set these before compiling to override the committed Esteria defaults:

```powershell
$env:ESTERIA_DEFAULT_MANIFEST = 'https://cdn.example.com/api/v2/client/live/manifest.json'
$env:ESTERIA_DEFAULT_ADDON_CATALOG = 'https://cdn.example.com/api/v2/addons/catalog.json'
$env:ESTERIA_DEFAULT_NEWS = 'https://cdn.example.com/api/v2/news.json'
$env:ESTERIA_DEFAULT_STATUS = 'https://cdn.example.com/api/v2/status'
$env:ESTERIA_DEFAULT_SOCIAL = 'https://cdn.example.com/api/v2/social.json'
$env:ESTERIA_DEFAULT_ACCOUNT_API = 'https://cdn.example.com'
$env:ESTERIA_DEFAULT_ARMORY = 'https://cdn.example.com/api/v2/armory/characters.json'
$env:ESTERIA_DEFAULT_DATABASE = 'https://cdn.example.com/api/v2/database/index.json'
$env:ESTERIA_DEFAULT_PATCH_LIST = 'patch.example.com'
npx --yes @tauri-apps/cli@2.12.1 build
```

The values are compiled into the Rust binary as defaults. Users can still override them in settings for testing.

## Development

```powershell
cargo run --manifest-path .\src-tauri\Cargo.toml
```

Run validation with:

```powershell
node --check .\ui\app.js
cargo test --manifest-path .\src-tauri\Cargo.toml
```

Build a release executable with:

```powershell
cargo build --release --manifest-path .\src-tauri\Cargo.toml
```

Build signed Windows installers and updater artifacts with:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\Users\Zach\esteria-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npx --yes @tauri-apps/cli@2.12.1 build
```

The private updater key is intentionally stored outside this repository. Back it up securely. Losing it prevents already-installed launchers from trusting future releases.

Publish the newest NSIS build to the CDN and generate `latest.json` with:

```powershell
.\tools\Publish-EsteriaLauncher.ps1 -UpdatesRoot 'G:\EsteriaCDN\launcher-updates'
```

## Still planned

- Authoritative game-account linking so a launcher sign-in also authenticates the WoW account
- Direct server-side snapshot generation from the AzerothCore character/world databases; the launcher-facing API is already isolated from database credentials
- Advanced Git add-on source support for developers

MPQ-internal patching from the old Electron launcher is intentionally not part of the first Tauri updater. For the initial player release, changed MPQs are delivered as complete verified files. This keeps client repair predictable and removes the native StormLib dependency from the new launcher.
