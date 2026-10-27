# Esteria Launcher

![Launcher](https://raw.githubusercontent.com/STRHercules/WoWLauncher/refs/heads/main/assets/pics/Previews/launcher.png)

A Battle.net-style desktop launcher for **Esteria**, a custom World of Warcraft 3.3.5a server. It installs and repairs the game client, launches it, manages add-ons, and gives players a game account page, character stats, an armory, a world database, screenshots, news, patch notes and a friends/chat network, all in one window.

Built with **Tauri 2** (Rust), plain HTML/CSS/JavaScript, and a small **AzerothCore module** that lets the launcher talk to the game server safely.

## Contents

- [How the pieces fit together](#how-the-pieces-fit-together)
- [For players: using the launcher](#for-players-using-the-launcher)
- [For server admins: running it](#for-server-admins-running-it)
  - [Game server module](#game-server-module)
  - [CDN service](#cdn-service)
  - [Publishing content](#publishing-content): patch notes, news, community links, add-ons, client files, launcher releases
- [Reference](#reference): settings, build-time defaults, endpoints, file formats
- [Rebranding for your own server](#rebranding-for-your-own-server)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known gaps](#known-gaps)

---

## How the pieces fit together

```text
                 +-------------------------------+
                 |        Esteria Launcher       |
                 |  Tauri app (Rust + web UI)    |
                 +---------------+---------------+
                                 |
          +----------------------+----------------------+
          |                                             |
+---------v-----------+                     +-----------v-----------+
|     CDN service     |                     |   Game server module  |
|  (Node, port 7384)  |                     |  mod-launcher-api     |
|                     |                     |  (inside worldserver, |
| client files        |                     |   port 8095)          |
| add-ons + catalog   |                     |                       |
| launcher updates    |                     | game account + login  |
| news, patch notes   |                     | characters + services |
| Esteria accounts,   |                     | live armory           |
| friends, chat, feed |                     | live world database   |
+---------------------+                     +-----------------------+
```

- The **CDN service** serves everything static or social: the game client, add-ons, launcher updates, news, patch notes, and the Esteria *social* accounts (friends, chat, community feed, avatars).
- The **game server module** runs inside the worldserver, so it can read the real databases without handing credentials to anything else. It powers the game account, characters, stats, Armory and World Database.
- The launcher talks to both. A player's Esteria social profile is linked permanently to their game account.

---

## For players: using the launcher

### Home

- **Play / Install / Update:** the big button changes with your install state. *Install* downloads the whole client into an empty folder, *Update* repairs or updates an existing one, *Play* appears when every managed file is verified.
- **Channel and realm:** pick Live or PTR under *Game version*. The sidebar shows whether the realm is online and which build is live.
- **Update marquee:** the banner at the top cycles through the newest stories. **Read story** opens the story inside the launcher.
- **Latest from Esteria:** the newest three stories as cards; click one to read it. **View all** opens the News tab with every story.
- **Development feed:** the newest patch-note entries. Click one to jump to it on the Patch Notes page.
- **Sidebar:** *Add-ons*, *Community* (social links) and *Patch Notes*.

### Installing and keeping the client healthy

1. Click the gear next to **Play** and choose an install folder. It can be empty, or an existing Esteria client the launcher will adopt.
2. Press **Install**. Downloads are resumable, verified with SHA-256, show speed and ETA, and can be **paused** and resumed from the sidebar.
3. If files go missing or corrupt, the launcher says how many need repair; press **Update** to fix just those.

An optional **Client download link** (in settings) lets you seed a fresh install from a direct `.zip`, or from a `magnet:` link that opens in your torrent client; the CDN then tops it up.

### Playing

- **Play** writes the realm list into `WTF/Config.wtf` (leaving your other settings alone), optionally clears the WDB cache, and starts `Wow.exe`. It refuses to start a second copy.
- The first time you press Play the launcher asks what to do while the game runs: **Minimize**, **Send to tray**, or **Keep open**. Tick *Remember* to stop being asked; change it later under settings (*When the game starts*).
- When the game closes, the launcher comes back by itself.
- The window's close button works the same way: *Close*, *Minimize*, or *Send to tray* (remembered under settings). With *Send to tray* the launcher keeps running in the system tray; click the tray icon to bring it back, or use its menu to quit.

### Game Account

The account tab (the portrait icon in the game strip). Sign in with your game account name and password, or **Create game account**. The same name and password also create/sign in your Esteria social account.

- **Your Esteria profile card** shows whether your social profile is linked to this game account. The link is **permanent**; it is made automatically the first time you are signed into both, and **Unlink** removes it.
- **Characters** are shown as cards with their real in-game **portraits**. With a large roster use the search box (name, race, class, zone, guild), the class and status filters (online, max level, still leveling, pending service, in a guild, idle 30+ days), the sort menu (level, name, class, zone, oldest) and the card/compact-list toggle. Large rosters load 48 at a time.
- **Services:** press **Services** on a character, or pick one in the *Apply to* menu, to start a Rename, Faction change, Race change or Re-customize. The service finishes the next time you pick that character at the in-game character screen; the character must be logged out.
- **Delete / Restore:** deleting is a soft delete. The character moves to *Deleted characters*, where **Restore** brings it back (needs a free slot and an unused name). Deleted characters are removed for good after the server's retention period (`CharDelete.KeepDays`, 30 by default).
- **Account security:** change your password (it also updates your Esteria social password if they match) and your email.

### Stats

The star icon. Totals and breakdowns across every character on your game account:

- Tiles: characters, total time played, total gold, max-level count, average level, classes and races played, honorable kills, achievements, honor and arena points, guild count, characters online, your highest-level, most-played and richest character, your most-played class, account age and last character seen.
- Bars: characters by class, race and level band.
- A sortable table with a row per character (level, class, played, gold, kills, achievements, honor, arena, last seen, guild). Click a column header to sort, click again to reverse.

### Armory and World Database

Both read **live** from the game server.

- **Armory:** search characters by name, guild, race, class or zone. Results show level, guild, item level, achievement points, last seen and full equipment. Playerbot characters are hidden unless the server enables them.
- **World Database:** search items, quests, NPCs, spells and zones by name or ID, filtered by type. With no search term it shows the legendary items. Jump from armory equipment straight to the matching item.

### Images

Screenshots from the client's `Screenshots` folder (newest 200). Add tags and private notes (stored only on your PC), rename a file, and **post** one to the community feed with a description. PNG, JPEG, WebP and GIF only; set `screenshotFormat` to `jpeg` in the game client.

### Add-ons

The Add-ons page installs and updates add-ons published by the server into `Interface\AddOns`. Packages are verified (SHA-256 and size) and unpacked safely. **Install required** installs everything the server marks required; required add-ons cannot be removed. Installed add-ons update automatically when the server publishes a newer version, if auto-update is on in settings.

### Community, Patch Notes and the social panel

- **Community** (sidebar): link cards for Discord and the other community sites. Links that are not set yet show *Coming soon*.
- **Patch Notes** (sidebar): a rich list of releases, newest first, with tag filters (Feature, Fix, Server, ...). The newest three are open; click a release to expand or collapse it.
- **Community feed** (top navigation): posts, screenshots and clips shared with your friends only.
- **Friends panel** (right): your profile, presence, friend list, search, requests and **Chats**. The tab on the panel's left edge **collapses** it to a thin strip (remembered between launches).
- **Profile** (click your name): display name, presence (Online, Away, Do Not Disturb, Appear Offline), status message, bio, header image, favorite character, avatar (animated GIFs work), and the Esteria account sign-in. It shows *Linked to game account X · permanent* when linked.
- **Chat** opens in its own window: one-to-one chats and group chats of up to 20 friends, with distinct incoming and outgoing sounds. Right-click a friend for profile, nickname, favorite and remove.
- **While you play,** your profile and friends list show `Playing Esteria - Level 72 Vrykul - Elwynn Forest`, and Discord rich presence is shown when a Discord application ID is configured.

### Notifications

The bell in the title bar shows a count and lists: a launcher update ready to install, friend requests, unread messages, and new patch notes since you last looked. Click an item to act on it.

### Launcher Tools

Verify and repair the install, shortcuts to the install folder, AddOns, WTF, Logs and Screenshots, WDB and hash-cache cleanup, launcher update check, and a diagnostics panel for support.

### Updating the launcher

The launcher checks for signed updates and offers **Install** in the update banner and in the notifications bell. Installs are passive and signature-checked.

---

## For server admins: running it

### Game server module

[`server-modules/mod-launcher-api`](server-modules/mod-launcher-api/README.md) is a standalone AzerothCore module. It gives the launcher:

- game account creation and login, password and email changes,
- character listing with full stats, delete/restore, and the rename / faction / race / re-customize services,
- presence (which character an account is playing now),
- **public live lookups** for the Armory and World Database (cached 60 seconds, rate-limited per IP).

Install:

1. Copy the folder to `azerothcore/modules/mod-launcher-api` and rebuild the worldserver (Docker builds: rebuild the worldserver image).
2. Copy `conf/mod_launcher_api.conf.dist` to `mod_launcher_api.conf` beside `worldserver.conf` and set `LauncherApi.Enable = 1`.
3. Open the port (default **8095**). For public servers either set `LauncherApi.Tls.Cert/Key` or put an HTTPS reverse proxy in front.
4. **Restart the worldserver** after rebuilding; module changes only load at startup.

Notes:

- The launcher's **Game server API** setting must point at this address (default `http://planetkai.hopto.org:8095`).
- Launcher deletes always **soft delete**, regardless of `CharDelete.Method`, so they can be restored. Deleting from the in-game client still follows your own `worldserver.conf` policy.
- `LauncherApi.Armory.IncludeBots = 1` shows `RNDBOT*` playerbot characters in the public armory (off by default).
- Tokens live in memory; a worldserver restart signs launchers out of the game account.

### CDN service

A small Node/TypeScript service (port **7384**) that serves the client, add-ons, launcher updates, news, patch notes and the Esteria social accounts. Esteria runs it from `G:\CDN` (service code in `G:\CDN\server`).

Start it with the launch script in the CDN root; it derives every path from the CDN root folder:

```cmd
G:\CDN\start_cdn.cmd /check    :: print the resolved paths without starting
G:\CDN\start_cdn.cmd           :: start the service
```

Typical CDN root layout:

```text
G:\CDN\
  client\live\          the game client (Wow.exe, Data\, Interface\, ...)
  addons\               add-on .zip files + catalog.json
  launcher-updates\     launcher installers + latest.json
  social\               Esteria accounts, friends, chat, avatars  (back this up)
  news.json             stories for the home page
  patchnotes.md         patch notes
  status.json  social.json  (optional)
  backups\
  server\               the CDN service itself
```

Operational rules:

- **Restart only when code or paths change.** Content that is read on every request needs no restart: `patchnotes.md`, `news.json`, `addons\catalog.json` and the add-on zips, and `launcher-updates\latest.json`.
- Whatever folder your launch script points at **is** your CDN: put content there, and keep exactly one copy of `social\` live. Do not run two roots.
- Put the service behind **HTTPS** before inviting players; account names and passwords travel in request bodies.
- Do not expose the `social` data directory or chat private storage through any static root.

### Publishing content

#### Patch notes

Edit **`patchnotes.md`** in the CDN root and save. The launcher shows it the next time Patch Notes is opened; no restart needed. The development feed on the home page is the newest entries.

Each release starts with a `##` heading: `## Title | Date | Tag`. Date (`YYYY-MM-DD`) and tag are optional. Newest first. Everything underneath is Markdown.

```markdown
<!-- Comments like this are ignored -->

## Launcher 0.8 | 2026-11-03 | Feature

A short intro paragraph.

### New
- **Bold**, *italic*, `code`, and [links](https://example.com)
- ![images](https://example.com/picture.png) work too

> Block quotes, numbered lists, code fences and --- dividers are supported.

---

## Hotfix | 2026-11-04 | Hotfix
- Fixed a crash on login.
```

Known tags get a colour: `Feature`, `Content`, `Fix`, `Hotfix`, `Server`, `Launcher`. Any other tag still works. Raw HTML in the file is escaped, and only `http(s)` links are made clickable.

#### News stories

Edit **`news.json`** in the CDN root (no restart needed). The marquee shows the newest three; the cards and *View all* list the rest. Stories open inside the launcher.

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "title": "Winter update is live",
      "category": "World",
      "publishedAt": "2026-12-01T12:00:00Z",
      "summary": "One sentence shown on the card and the marquee.",
      "body": "## Full story\n\nMarkdown, same as patch notes.",
      "imageUrl": "https://cdn.example.com/images/winter.png",
      "url": "https://example.com/optional-external-link"
    }
  ]
}
```

Only `title` is required. A story with `body` or `summary` opens in the launcher; one with only `url` opens in the browser. `url` also adds a *Read more online* button to a story that has text. The first items are the newest.

#### Community links

The Community page is built from the `COMMUNITY_LINKS` list at the top of [`ui/pages.js`](ui/pages.js). Set `url` for each site (an empty `url` shows *Coming soon*); the change ships with the next launcher release.

#### Add-ons

Add-ons are served as `.zip` files plus a `catalog.json`. Each zip has its add-on folder at the **root** (`Questie.zip` -> `Questie\Questie.toc`). To publish:

1. Put the zips in the CDN's `addons` folder.
2. Generate the catalog (reads each zip's `.toc` for title, notes, author and version; hand edits to category, `required`, homepage and changelog are kept on the next run):

```powershell
node tools/build-addon-catalog.mjs G:/CDN/addons http://planetkai.hopto.org:7384/addons
```

3. Players see the add-on on the next refresh. Bumping the version in the zip's `.toc` and re-running the script publishes an update.

To change category, mark an add-on `required: true`, or add a changelog, edit `catalog.json` directly; the file format is described under [Add-on catalog format](#add-on-catalog-format).

#### Client files

Two supported ways to produce the client manifest:

- **The CDN builds it** (default): it hashes the client tree into `manifest-v2.json` and serves `/api/v2/client/<channel>/manifest.json`. Player-generated state (Logs, Screenshots, WDB, account WTF data, `.launcher`) is excluded.
- **Developer-controlled delivery** with a policy file and the staging script, see [Developer-controlled file and folder delivery](#developer-controlled-file-and-folder-delivery).

After changing client files, restart the CDN so it re-hashes the tree and refreshes the manifest. Verify in the launcher: it should report no files needing repair.

#### Launcher releases

1. **Bump the version** in all four places: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `esteria-launcher` entry in `src-tauri/Cargo.lock`.
2. **Build and sign** (see [signing](#signing-key)):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\esteria.key"   # a path or the key text
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npx tauri build
```

   Without the key, the installers build but no `.sig` files are produced and the updater cannot use them.
3. **Publish** the NSIS installer, its `.sig`, and `latest.json` to the CDN's `launcher-updates` folder. `tools/Publish-EsteriaLauncher.ps1 -UpdatesRoot <path> -Notes "What changed"` does this (it refuses to publish without a `.sig`); the manifest it writes is:

```json
{
  "version": "0.7.9",
  "notes": "What changed",
  "pub_date": "2026-10-27T19:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "http://planetkai.hopto.org:7384/launcher-updates/Esteria%20Launcher_0.7.9_x64-setup.exe"
    }
  }
}
```

4. Check `…/launcher-updates/latest.json` shows the new version and that the downloaded installer matches your build.

Installed launchers check this manifest, verify the signature against the public key compiled into them, and offer the update. Only the **NSIS** installer is used for updates; the MSI is for manual installs.

---

## Reference

### Launcher settings

Open the gear next to **Play**. Settings are saved to `%APPDATA%\EsteriaLauncher\settings.json`.

| Setting | Purpose |
| --- | --- |
| Install folder | Where the client lives (can be empty). |
| Game channel | `live` or `ptr`; switches channel-aware manifest URLs. |
| Client manifest, Add-on catalog | CDN endpoints for client files and add-ons. |
| News, Status, Social sources | CDN endpoints for stories, realm status, presence snapshot. |
| Patch notes source | Defaults to the CDN's `/api/v2/patchnotes.md`. |
| Armory / Database sources | Default to the game server module's live `/launcher/v1/armory` and `/database`. |
| Account API | The CDN origin for Esteria accounts, friends and chat. |
| Game server API | The game server module (default port 8095). |
| Realm host / port, Patch list | Written into `WTF/Config.wtf` on launch. |
| Clean WDB before launch | Deletes the `WDB` cache before starting the game. |
| When the game starts / When closing | `ask`, minimize, tray, keep/close; remembered choices. |
| Auto-update add-ons | Keeps launcher-managed add-ons current. |
| Client download link | Optional `.zip` or `magnet:` to seed a fresh install. |
| Discord rich presence | Shown when a Discord application ID is compiled in. |

### Build-time defaults

Player builds can ship with every endpoint pre-filled so players never see CDN URLs. Set these before compiling; players can still override them in settings.

```powershell
$env:ESTERIA_DEFAULT_MANIFEST      = 'https://cdn.example.com/api/v2/client/live/manifest.json'
$env:ESTERIA_DEFAULT_ADDON_CATALOG = 'https://cdn.example.com/api/v2/addons/catalog.json'
$env:ESTERIA_DEFAULT_NEWS          = 'https://cdn.example.com/api/v2/news.json'
$env:ESTERIA_DEFAULT_PATCH_NOTES   = 'https://cdn.example.com/api/v2/patchnotes.md'
$env:ESTERIA_DEFAULT_STATUS        = 'https://cdn.example.com/api/v2/status'
$env:ESTERIA_DEFAULT_SOCIAL        = 'https://cdn.example.com/api/v2/social.json'
$env:ESTERIA_DEFAULT_ACCOUNT_API   = 'https://cdn.example.com'
$env:ESTERIA_DEFAULT_GAME_API      = 'https://game.example.com:8095'
$env:ESTERIA_DEFAULT_ARMORY        = 'https://game.example.com:8095/launcher/v1/armory'
$env:ESTERIA_DEFAULT_DATABASE      = 'https://game.example.com:8095/launcher/v1/database'
$env:ESTERIA_DEFAULT_PATCH_LIST    = 'patch.example.com'
$env:ESTERIA_DEFAULT_DISCORD_CLIENT = '<Discord application ID>'   # enables Discord rich presence
npx tauri build
```

### CDN endpoints

```text
GET  /api/v2/build-status?channel=live
GET  /api/v2/client/<channel>/manifest.json
GET  /api/v2/addons/catalog.json
GET  /api/v2/news.json
GET  /api/v2/patchnotes.md
GET  /api/v2/status
GET  /api/v2/social.json
GET  /client/<channel>/<relative-file-path>
GET  /addons/<package-file>
GET  /launcher-updates/latest.json
```

Esteria account and social routes (bearer token after login):

```text
POST   /api/v2/account/register        { username, password, displayName? }
POST   /api/v2/account/login           { username, password }
POST   /api/v2/account/logout
GET    /api/v2/account/me
POST   /api/v2/account/profile         { displayName?, statusMessage?, presence?, bio? }
POST   /api/v2/account/password        { current, new }
POST   /api/v2/account/game-link       { gameToken }      links this profile to the signed-in game account
DELETE /api/v2/account/game-link                          unlinks it
PUT    /api/v2/account/avatar          { mimeType, dataBase64 }
DELETE /api/v2/account/avatar
PUT    /api/v2/account/header          { mimeType, dataBase64 }
DELETE /api/v2/account/header
GET    /api/v2/social/feed
POST   /api/v2/social/heartbeat        { presence?, statusMessage?, displayName? }
GET    /api/v2/social/discover?q=<name>
POST   /api/v2/social/friends          { username }
POST   /api/v2/social/friends/accept   { username }
DELETE /api/v2/social/friends/<username>
GET    /api/v2/social/messages?with=<username>&since=<id>
POST   /api/v2/social/messages         { to, body }
GET    /api/v2/social/groups           POST /api/v2/social/groups { name, members }
GET    /api/v2/social/posts?since=<id> POST /api/v2/social/posts { body, mimeType?, dataBase64? }
```

Profile links are verified server-side: the CDN asks the game server's launcher API who owns the supplied game token, so a client can never claim an account name. A game account can link to only one profile, and a profile to only one game account, until unlinked. Passwords are stored as scrypt hashes; avatars accept PNG, JPEG, WebP and GIF.

### Game server endpoints

Served by `mod-launcher-api` under `/launcher/v1/` (see the [module README](server-modules/mod-launcher-api/README.md)):

```text
GET  info                              feature flags
POST register | login | logout
GET  me                                account name and email
POST password | email
GET  characters                        live and deleted characters with stats
POST characters/<guid>/delete | restore | service
GET  presence
GET  armory?q=                         public, cached 60 s
GET  database?q=&type=                 public, cached 60 s
```

### Client manifest format

The CDN generates this automatically; hand-authored manifests also work for testing.

```json
{
  "schemaVersion": 2,
  "channel": "live",
  "version": "2026.10.07.1",
  "files": [
    { "path": "Wow.exe", "sha256": "<64-character SHA-256>", "size": 12345678, "url": "/client/live/Wow.exe" }
  ]
}
```

Parent traversal and absolute client paths are rejected.

### Add-on catalog format

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
      "author": "Questie team",
      "category": "Quests",
      "homepage": "https://example.com",
      "changelog": "What changed in this version.",
      "packageUrl": "Questie.zip",
      "sha256": "<64-character SHA-256>",
      "size": 4839210,
      "folders": ["Questie"],
      "required": false
    }
  ]
}
```

`packageUrl` may be absolute or relative to `baseUrl`. `folders` lists every add-on folder at the root of the zip (several for add-ons with companion modules). `required: true` marks an add-on as non-removable and installed by **Install required**. `tools/build-addon-catalog.mjs` writes all of this for you.

### Developer-controlled file and folder delivery

Copy `delivery.example.json` to `.delivery.json` in your **source client** and edit it:

```json
{
  "include": ["Wow.exe", "Data/*.mpq"],
  "exclude": ["*.pdb", "*.bak", "Logs", "Screenshots", "WDB", "WTF", ".launcher"],
  "folders": [
    { "path": "Data/Patch-Housing.MPQ", "delivery": "zip" },
    { "path": "Extensions", "delivery": "files" }
  ]
}
```

- `include` selects files, folders (with contents) or wildcard patterns. Nothing is selected implicitly when a policy exists.
- `folders` selects a folder too. `files` delivers its files individually; `zip` creates one compressed download that the launcher verifies and unpacks.
- `exclude` always wins, including inside zip folders. Paths are relative to the source client, case-insensitive, and use PowerShell wildcards (`*`, `?`, `[abc]`); `*` can cross directory separators.
- Folder entries must exist and must not overlap. Unknown options, unsafe paths, selected `.launcher` state and links/junctions in the source tree fail the build.

Build a release with **PowerShell 7.2+**:

```powershell
pwsh -File .\tools\New-EsteriaManifest.ps1 `
  -PayloadRoot 'D:\ServerClient' `
  -PublishRoot 'D:\CDN-Releases\2026.10.22.1' `
  -OutputPath 'D:\CDN-Releases\2026.10.22.1\manifest.json' `
  -Version '2026.10.22.1' `
  -BaseUrl 'https://cdn.example.com/client/releases/2026.10.22.1/'
```

`PublishRoot` must be new or empty and outside the source tree; `OutputPath` goes directly inside it. Upload the **contents** of `PublishRoot`, including the `.bundles` folder, then point the launcher's manifest setting at the generated manifest (or serve it unchanged from the CDN's manifest endpoint). Upload payloads first and switch the manifest last, and keep old release folders while players may still be downloading them. A missing or corrupt file inside a zip folder re-downloads that whole zip, so use zips for many small files and individual delivery for large independent files. Self-test: `pwsh -File .\tools\Test-EsteriaDelivery.ps1`.

For pre-built archives, the CDN also recognises `.delivery-bundles.json` in the client folder (`[{ "path": "Data/Patch-Housing.MPQ", "archive": "Data/Patch-Housing.MPQ.zip" }]`); the expanded folder stays authoritative for per-file verification.

---

## Rebranding for your own server

The name and identity live in `branding.json`:

```json
{ "name": "Esteria", "identifier": "gg.esteria.launcher" }
```

`tools/Set-Branding.ps1` rewrites every place the name is compiled in or shown, then updates `branding.json`. Pass the brand word only; the launcher adds "Launcher" and "Chat" where needed.

```powershell
.\tools\Set-Branding.ps1 -Name 'Azeroth'                                  # application ID defaults to gg.<brand>.launcher
.\tools\Set-Branding.ps1 -Name 'Azeroth' -Icon .\art\azeroth-icon.png      # also regenerates all icons from one square PNG
npx tauri build
```

| Field | Where it lands |
| --- | --- |
| `name` | Window titles, tray tooltip and menu, installer/product name, install folder, shortcuts, launcher UI text, and the `%APPDATA%` settings folder. |
| `identifier` | The Tauri application ID. Windows and the signed updater use it to recognise an installed copy; give your build its own unless you are shipping updates for the same install. |
| `-Icon` | Regenerates every file in `src-tauri\icons\` and the embedded fallback `src-tauri\icon.b64`. |

The executable stays `esteria-launcher.exe` and the build-time overrides keep their `ESTERIA_DEFAULT_*` names. In-app artwork lives in `ui\assets\`; overwrite files keeping the same names (`esteria-icon.png`, `esteria-wordmark.png`, the `tab-*.png` icons, `hero-*.svg`, `news-*.svg`, `sidebar-world.svg`). If you hand-replace `src-tauri\icons\`, keep `icons\icon.ico` or delete `icon.b64`, otherwise the build restores the old icon.

---

## Development

Requirements: Rust (stable), Node 20+, and the Tauri 2 prerequisites for Windows (WebView2, MSVC build tools).

```powershell
npm install                                              # installs the Tauri CLI
npx tauri dev                                            # run the app in development mode (UI files load from ui/; restart to pick up UI edits)
cargo check --manifest-path .\src-tauri\Cargo.toml       # quick type check
cargo test  --manifest-path .\src-tauri\Cargo.toml       # unit tests
node --check .\ui\app.js                                 # syntax-check a UI script (same for the others)
npx tauri build                                          # signed installers (see Launcher releases)
```

Installers appear in `src-tauri\target\release\bundle\nsis` and `...\msi`. A release build needs a few GB of free disk; set `CARGO_TARGET_DIR` to put build output on another drive.

### Signing key

Updates are verified against the **public key** in `src-tauri/tauri.conf.json`. The matching **private key** must stay outside the repository and be backed up: if it is lost, already-installed launchers can never trust a future release and must be reinstalled by hand.

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\esteria.key"    # new key pair; paste the .pub into tauri.conf.json
```

Tauri 2 reads `TAURI_SIGNING_PRIVATE_KEY` (a key file path or the key text) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Changing the key means every installed launcher must reinstall once.

### Repository layout

```text
src-tauri/            Rust backend: install/verify/download engine, add-ons, settings, tray, commands
  src/main.rs         core launcher logic and Tauri commands
  src/extras.rs       pause/resume, screenshots, Discord presence, character portraits from client MPQs
ui/                   the interface (no build step)
  index.html styles.css
  app.js              shell, news, social panel, profile, settings, armory, database, tools
  game.js             game account, characters, images, presence
  stats.js            Stats tab
  pages.js            Community, Patch Notes, story reader, notifications, friends-panel collapse, profile link
  chat.* chat-media.js  the chat window
server-modules/mod-launcher-api/   AzerothCore module (game account, characters, live armory/database)
tools/                manifest builder, delivery tests, add-on catalog builder, release publisher, branding
addon/EsteriaChat/    in-game chat addon (staged)
native/               client-side chat extension and media helper (staged)
docs/                 in-game chat design and operations notes
```

Character portraits are read at runtime from the player's own client files (the `TemporaryPortrait-*` textures in the MPQs), so custom races work without shipping any artwork.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Stats tab, new character stats, or Armory / World Database are empty | The game server module is not rebuilt, not running, or port 8095 is not reachable. Rebuild the worldserver with the current `mod-launcher-api`, restart it, and check `http://<host>:8095/launcher/v1/info`. |
| Deleted a character and it is not under *Deleted characters* | An old module build hard-deleted it (the core erases characters when `CharDelete.Method = 0`). The current module forces a soft delete; a character deleted by the old build cannot be recovered. |
| Add-ons page is empty | `addons\catalog.json` is missing from the folder the CDN serves. Run `tools/build-addon-catalog.mjs`. |
| Patch Notes says *No patch notes have been published yet* | `patchnotes.md` is missing from the CDN root, or the CDN is serving a different root. Check the launch script's `/check` output. |
| Launcher does not offer an update | `launcher-updates\latest.json` is older, or the installer was built without the signing key (no `.sig`). Installs older than the current key must be reinstalled manually. |
| Profile will not link to the game account | Sign into the game account first; the CDN must reach the game server at `http://127.0.0.1:8095` (set `GAME_API_URL` for the CDN if it is elsewhere). Another profile may already own that game account. |
| Build fails with "no space on device" | Free disk, or set `CARGO_TARGET_DIR` to another drive. |
| Installers build but no `.sig` appears | `TAURI_SIGNING_PRIVATE_KEY` is not set in that terminal (use that exact name; `..._PATH` is the old Tauri 1 variable). |
| Discord presence never shows | No Discord application ID was compiled in; set `ESTERIA_DEFAULT_DISCORD_CLIENT` before building. |

---

## Known gaps

- **In-game chat** (addon, native extension, bridge): source is staged under `addon/`, `native/` and `docs/` but is not deployed; see `docs/in-game-chat-operations.md` for the rollout gates.
- **Community links** other than Discord are placeholders until their URLs are set in `ui/pages.js`.
- **Discord rich presence** needs a Discord application ID at build time.
- Character portraits skip client archives larger than 8 GB, and Images shows the newest 200 screenshots.
- Advanced Git add-on sources for developers are not implemented.
- MPQ-internal patching from the old Electron launcher is intentionally not included: changed MPQs are delivered as complete verified files, which keeps repair predictable and avoids a native StormLib dependency.
