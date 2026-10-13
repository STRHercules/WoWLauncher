# Chat implementation and operations

Source implementation is staged for review. Nothing has been deployed to the client, worldserver or
public CDN. The acceptance gates in `in-game-chat-implementation.md` remain the release gate.

## Source map

- Launcher: `ui/chat.js`, `ui/chat-media.js`, `ui/chat.html`, `ui/chat.css`.
- Shared service: `../EsteriaWoW/Launcher-src/server/src/social/chat.ts`, `chat-routes.ts`, existing
  `store.ts`, `service.ts`, and `routes.ts`.
- Game module: `../EsteriaWoW/modules/mod-esteria-chat` (disabled by default).
- Addon: `addon/EsteriaChat`, interface 30300, custom TGA textures, Noto Sans (OFL license), launcher sounds.
- Client: `native/extension/Module.cpp`, `native/helper/Program.cs`, and `native/CMakeLists.txt`.

## Backend configuration

Run one Node 24+ social-service process with its existing social data directory. Install its updated
package dependencies using the lockfile. `sharp` validates full image/GIF decodes and generates private
bounded helper previews. The Dockerfile now uses Node 24. No world/database migration is needed.

Use `chat-owner.env.example`. Set a random bridge secret of at least 32 characters in backend environment
and the core's config; never ship that secret. Backend settings override frontend checks. All positive
numeric media limits accept at most 16 times the suggested default (or 1000 where larger), with tighter
caps: dimensions <=8192, frames <=240, total decoded frame pixels <=268435456, and attachments/animations
<=8. File <= message bytes <= account/storage capacity; orphan duration <= attachment duration. Zero
and invalid combinations fail startup with a named error. Formats are `png,jpg,gif,webp` or a subset.
Features can be disabled centrally. Character details are disabled by default and require player opt-in.

Brand colors, product name, and a packaged font filename are sanitized capabilities. To change font,
ship that font in both `ui/assets/chat` and addon `Assets`; keep its license. Lua `Config.lua` supplies
the offline defaults, textures and notification sound filenames. Protocol version 1 has no branding
identity embedded in packet names or social account resolution.

Require HTTPS for public launcher, helper and core traffic. HTTP is allowed by the helper/core only on
loopback. The existing launcher account origin is configured separately; set it to the same TLS origin.
Never expose the private storage directory through Express, nginx, a client manifest, or a CDN static root.
The backend checks its configured static roots at startup.

Example nginx locations (adjust 10m when raising the per-file limit; binary uploads have no base64 overhead):

```nginx
location /api/v2/ {
    client_max_body_size 10m;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_pass http://127.0.0.1:7384;
}
```

Leave existing avatar/header/community upload locations at their own existing limits. Do not apply chat
retention to their original assets. Block public `/api/v2/bridge/` at the edge; allow only the configured
core network. The core also authenticates every request with the service secret.

## Storage, migration, retention and rollback

On first startup, SQLite imports the existing `accounts.json` and `social.json` without replacing them.
Unread/read data and durable IDs are retained. An unsupported schema, malformed JSON or inaccessible
file aborts migration rather than silently replacing user data. SQLite/WAL commits accounts and social
metadata together. A revision check rejects competing writers; persistence failure disables API traffic
until storage is fixed and the service restarted. This is deliberately a single-process snapshot store;
normalize the tables before large histories/high load. Current metadata has no automated message/audit
deletion; attachments alone have the finite retention policy. Owners must set their metadata backup/audit
retention procedures and monitor capacity before public rollout.

Before deployment, stop the old social process and take a verified copy of its data directory and source.
Test migration on a copy. Do not run old JSON and new SQLite processes against the same live directory.
Original media lives in `SOCIAL_DATA_DIR/chat-private` under opaque filenames. Temporary files and orphans
are cleaned independently of attached messages. Expiry is enforced on each read even if deletion failed.
Cleanup is serialized with uploads, retries on every sweep, and catches up at startup. It rejects unsafe
filenames and never recurses outside the managed folder. Failures produce an attachment ID only in logs;
owner cleanup/report status is available through authenticated `GET /api/v2/bridge/chat/reports`.

Shorter retention caps existing expiry on reload/startup. Longer retention affects new uploads only.
Capabilities refresh every 30 seconds in the launcher/helper; game preferences are constrained by the
backend on every operation. The helper refreshes each media permission at most every 15 seconds and
purges originals/decoded frames at the reported expiry. The native renderer also stops drawing at the
expiry timestamp. Both caches are bounded and memory-only; there is no persistent helper cache to back up.
Server previews are generated on demand and never persisted. Every delivery uses `private, no-store`.

Exclude `chat-private` from backups. Metadata backups may retain expiry timestamps, but never restore
ephemeral originals from indefinite backups. If a finite recovery copy is required, delete it within the
same attachment lifetime, retain its original timestamps, and run cleanup before opening restored API
traffic. A restore must never publish the private root as static files.

For rollback after writes, stop all social writers and run from the server directory:

```powershell
rtk npm run export:social-legacy
```

This exports a consistent accounts/social snapshot for the old service; keep SQLite, WAL and the verified
deployment backup intact. Old text endpoints cannot display new attachments. Disable the module, remove
the new addon/native manifest entries and restore their backed-up files. Do not roll back a database by
discarding new messages. No `Wow.exe` change or rollback is involved.

## Linking and game use

Launcher chat → Game accounts → Create link code. In the authenticated game session use `/ec link CODE`.
The launcher then displays the social username, actual character name, stable game account ID and realm.
Confirm those identities in the launcher. Codes expire in five minutes, can be proposed once, and are
consumed at confirmation. Username matching is never accepted. A game account has one social owner;
the owner-controlled social-account cardinality defaults to one. Links/unlinks are audited. Unlinking
revokes game bridge resolution and all related helper tickets.

`/ec` opens the addon. Friend + adds/accepts requests; Group + creates a group from social friends. Use
the composer for text, Attach for the helper-owned file picker, and Older for paginated history. Pending
uploads can be cancelled with `/ec cancel`; abandoned uploads expire. `/ec friend NAME`, `/ec accept NAME`,
`/ec removeFriend NAME`, `/ec group NAME;friend1,friend2`, `/ec block NAME`, `/ec unblock NAME`,
`/ec report MESSAGE_ID reason`, `/ec presence online|away|dnd|offline`, `/ec privacy on|off`,
`/ec sounds`, and `/ec scale 0.6..1.5` are available. Position, dimensions, sound/autoplay/scale preferences
are SavedVariables; credentials and message content are not. Players may select Appear Offline without
stopping game chat. Optional character details are opt-in. Group removal revokes history/media access.

Addon protocol: `EC1` prefix, self-whisper, `1:requestId:part:count:payload`, <=180 payload bytes,
<=128 fragments/23040 bytes, 15-second assembly/request timeout, bounded queues/flood budgets. The module
overwrites any supplied account/realm identity with the core session's account and configured realm.
Worker HTTP uses verified TLS, a five-second deadline, no redirects and bounded replies. World updates
only drain bounded results; Player pointers never survive HTTP work. Responses use session generations
to reject stale relog results. No image bytes go through chat packets. The short-lived helper ticket is
media-only, in-memory Lua, and useless without a linked account; no password/service secret/launcher
bearer token enters Lua, SavedVariables or decoded pixel buffers.

Media extension: supported WXL build 12340, D3D9, Win32. The build embeds the supplied client's SHA-256
and refuses other executable images. It registers only its own permitted script callbacks and swaps
the addon's eight dedicated marker textures at D3D texture bind; native WoW UI handles clipping, layering,
scrolling, resizing and UI scale. Device-loss releases default-pool textures. A missing extension/helper
retains text and clear placeholders. Eight visible surfaces share the configured animation cap.
Static/animated friend avatars use authorized previews; original avatar retention remains separate.

The extension starts the helper hidden when needed, without the launcher. A random named-pipe name,
same-user pipe restriction and mutual process-ID checks authenticate local IPC. Messages and BGRA frames
are length-bounded. Only media downloads/uploads use short-lived tickets. Game departure closes the
pipe/stops the owned helper; the helper also watches game exit. It cannot launch arbitrary executables
or navigate arbitrary URLs. Stop/restart the helper to test clear recoverable placeholders.

Server deletion cannot retract screenshots, deliberately saved files or copies outside managed caches.
Users see this boundary with attachment availability information; include it in the server's user policy.

## Build and distribution staging

Do not modify the development client during packaging. Run:

```powershell
rtk proxy pwsh -NoProfile -File tools/Package-EsteriaChat.ps1 -ApiOrigin https://chat.example.org
```

This builds a fingerprint-guarded Win32 WXL DLL and self-contained helper, runs the native harness,
stages an addon ZIP/catalog using the existing addon publisher, and creates a SHA-256 client manifest
fragment plus package receipt. It refuses to overwrite an existing staging folder. Merge the client
fragment into the owner's normal client update manifest and addon entry into the owner's current catalog
only after acceptance; it does not replace a full client/addon manifest or publish anything. The normal
launcher client updater verifies native/helper files and the addon manager verifies/extracts the addon ZIP.
Set the same social origin in backend, core and staged `chat-media.ini`.

Core build remains pending: EsteriaWoW `AGENTS.md` disallows configuring/building without an explicit
build request. Configure/build the module under that repository's documented workflow once authorized.
No SQL or core-wide behavior is changed. The WXL core itself is not rebuilt or patched.

## Verification and pending acceptance

Executed: social regression suite, chat security/lifecycle suite, TypeScript check, Lua JSON/fragmentation
harness, Win32 native build, helper build, real helper authenticated IPC/decode/expiry test, D3D9 texture
replacement/resource-release harness, and launcher browser fixture with attachment/expired placeholder
and send behavior. These checks operate on temporary data and do not prove game UI runtime behavior.

Still required before release: core module compile/link, two authenticated linked game accounts and a
launcher, all three cross-interface chat paths, in-game asset appearance at multiple resolutions/scales,
actual marker texture format/alpha preservation, scrolling/clipping/layering, GIFs and avatars, file picker,
launcher-close independence, relog/reload/character switch, exit, alt-tab/device reset, owner TLS/CDN/proxy
configuration, physical cleanup failure recovery and real backup policy. No supplied screenshot was
available in this checkout to certify visual parity. The feature is not live-accepted or release-ready.
