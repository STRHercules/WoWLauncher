# Launcher and in-game chat implementation

Status: source implementation and isolated verification in progress; no chat bridge or native media
integration has been deployed. See `in-game-chat-operations.md` for source paths, configuration,
verification evidence, rollout/rollback instructions, and the remaining live acceptance gates.

## Objective

Provide one account-based social experience in the Esteria launcher and a World of Warcraft
3.3.5a addon connected to AzerothCore. Players share friends, conversations, group chats, message
history, unread state, and presence across both interfaces. The in-game interface reproduces the
launcher's appearance using custom assets. Images and GIFs display inside its conversation panel.

Server owners control branding, supported features, upload limits, and the shelf life of chat media.
Chat attachments must not accumulate indefinitely on the backend/CDN.

## Target repositories and client

- Launcher: `R:\Users\Zach\Documents\GitHub\Launcher`.
- AzerothCore: `R:\Users\Zach\Documents\GitHub\EsteriaWoW`.
- Existing social backend: `EsteriaWoW\Launcher-src\server\src\social`.
- Development client: `G:\3.3.5a - Dev`.
- Existing native media reference: `R:\Users\Zach\Documents\GitHub\AzerothPlex`, particularly
  `build\wxl-core\extensions\wxl-azeroth-plex` and its frame bridge/texture rendering.

The launcher currently uses bearer-authenticated social endpoints for direct messages, groups,
friends, and heartbeats. Its social storage is JSON-backed. The inspected account model contains
`gameAccount`, but a verified game-account linking flow remains to be implemented. Existing chat
message endpoints carry text; community media support is not automatically chat attachment support.
The core contains AIO transport code, and the development client contains WarcraftXL extensions.
These are integration foundations, not proof that the proposed chat/media integration works live.

## Architecture

```text
Launcher ---------------------- Social API and private media storage
                                      |
                               AzerothCore chat module
                                      |
                               addon message transport
                                      |
                              EsteriaChat Lua addon
                                      |
                           WarcraftXL chat/media extension
                                      |
                         local media helper and bounded cache
                                      |
                         authorized Social API media download
```

### Social backend

Remain the authority for social identities, friend relationships, group membership, messages,
read state, attachment permissions, expiry, and aggregate presence. Extend existing services
rather than create a separate in-game conversation store. Add verified account links and a
restricted server-to-service authentication mechanism.

### AzerothCore module

Implement `mod-esteria-chat` as the game-session bridge. Resolve the social identity from the
authenticated AzerothCore account; never trust an account ID supplied by addon Lua. Relay social
operations and game-presence changes, with authorization and rate limits. Perform network work
asynchronously and apply results on the appropriate core thread without blocking world updates.

Use existing AIO if its runtime behavior and limits fit this integration; otherwise use a dedicated
addon-message protocol. AIO alone does not connect the game to the HTTP social service.
Transport small structured messages with versioning, bounded fragmentation/reassembly, request
IDs, timeouts, and flood limits. Do not move image bytes through addon chat packets.

### In-game addon

Implement `EsteriaChat` for interface version 30300. Provide conversation navigation, friends,
group creation, history pagination, composer, timestamps, unread indicators, notifications,
presence, and attachment placeholders. Persist personal UI preferences through SavedVariables.

Use custom packaged fonts, icons, textures, and sounds derived from the launcher design. Do not
use Blizzard artwork or default WoW decorative skins. WoW frames can provide interaction and
layout while the visible design matches the launcher: dark backgrounds, gold accents, rounded
bubbles, matching typography, and draggable/resizable panels. Handle differing resolution and
UI scale without stretching artwork or making controls unreadable.

### Native client extension and helper

Implement a dedicated WXL chat/media extension. Ordinary 3.3.5a Lua addons cannot make HTTP
requests, decode arbitrary downloaded images, or animate GIFs natively. The extension must bridge
addon media placement to native textures, including clipping, scroll position, draw order,
visibility, resizing, and UI scale. The existing AzerothPlex bridge is a reference to reuse where
appropriate, not a completed addon-texture integration.

Decode media in a separate helper process and transfer bounded decoded frames through an
authenticated local IPC channel. The launcher can start/manage that helper, but closing the
launcher must not break in-game chat: the helper remains available while the game needs it.
Stop it and release resources when the game session ends. Handle client renderer resets and
alt-tab transitions safely. Keep passwords and long-lived launcher bearer tokens out of Lua,
SavedVariables, and shared-memory frame buffers.

Prefer the existing WXL loading mechanism for this client. Do not patch `Wow.exe` as the default
approach. If a necessary native integration cannot be achieved through WXL, document the precise
limitation and proposed change before separate authorization for executable modification. Any
authorized binary work requires expected-image checks, verified backups, and a rollback path.
Stock-client compatibility is a separate distribution requirement; the media addon requires a
supported native loader/extension.

## Account linking and synchronized behavior

Use an expiring, single-use linking challenge that proves control of both the signed-in launcher
account and the authenticated game account. Confirm the intended identities before consuming the
challenge. Matching usernames is insufficient. Persist the link using realm/server identity and
stable game/social account IDs; enforce the configured linking cardinality and audit link/unlink
operations. Unlinking revokes related helper credentials and server access.

Once linked, all characters on the permitted game account use the same social identity. No
launcher password entry in the addon is required, and the launcher need not remain open.

- Launcher-only and game-only users can exchange messages with each other.
- Direct and group chats use the same IDs, ordering, history, and permissions in both interfaces.
- Durable message IDs and idempotent submission prevent duplicate messages after retries.
- Reading a visible conversation updates shared read state; background fetching must not mark it read.
- Presence aggregates launcher and game sessions. Closing one must not mark the account offline
  while another remains active. Preserve Away, DND, and Appear Offline preferences.
- Optional character/realm presence must respect owner policy and player privacy preferences.
- Relogging or switching characters preserves identity and catches up from a message cursor.
- Service outages show a clear disconnected state. Do not report failed sends as delivered.

## Media parity and scope

Support inline static images, animated GIFs, and static/animated avatars used by the launcher.
Attachment downloads, decoding, and caching use the helper/native path. Synchronize animation
timing with decoded frame delays and stop/pause work for hidden media. Provide a player setting
to disable autoplay and a sensible cap on concurrent visible animations.

Provide image/GIF attachment sending from both interfaces. A native file picker or helper-owned
upload window supplies in-game file selection because addon Lua cannot read arbitrary local files.
An attachment is uploaded and validated before a message references it. Failed uploads can be
retried or cancelled without leaving permanent orphaned files.

Here, full media parity means the image/GIF features agreed for chat, including viewing and
sending from either interface. Video, arbitrary HTML, external website embeds, and browser-only
features require explicit additional scope. An embedded browser is not required for images/GIFs.
If native media support is missing or incompatible, retain text chat and show an informative
attachment placeholder; do not claim full media support on that client.

## Chat media shelf life and upload limits

### Owner policy

All uploaded chat attachments have a finite, owner-configurable shelf life measured from successful
upload creation. Viewing or downloading an attachment does not extend it. The UI exposes its expiry
where useful. Retention applies equally to direct and group conversations, including media sent to
offline users. Do not allow an unlimited-retention setting in the initial implementation.

Suggested initial defaults, adjustable by the owner:

| Setting | Suggested default | Purpose |
| --- | --- | --- |
| `ChatMedia.RetentionHours` | 168 (7 days) | Maximum attachment availability from creation |
| `ChatMedia.MaxUploadBytes` | 10485760 (10 MiB) | Hard per-file upload limit |
| `ChatMedia.MaxAttachmentsPerMessage` | 4 | Bounds message fan-out and rendering work |
| `ChatMedia.MaxMessageUploadBytes` | 20971520 (20 MiB) | Combined attachment limit per message |
| `ChatMedia.CleanupIntervalSeconds` | 300 | Physical deletion sweep interval |
| `ChatMedia.OrphanRetentionMinutes` | 60 | Removes uploads never attached to a message |
| `ChatMedia.CacheMaxBytes` | 268435456 (256 MiB) | Suggested local helper cache ceiling |
| `ChatMedia.MaxConcurrentAnimations` | 3 | Suggested client animation ceiling |

Also configure allowed formats, maximum dimensions, decoded pixel/frame budgets, animation
duration/frame limits, per-account upload rate and storage quota, and total storage budget.
Compressed upload size alone does not protect the client from huge decoded images or GIFs.
These limits are validated positive values within documented supported bounds. Zero must not
silently mean unlimited. Owners receive actionable startup errors for invalid combinations.

The backend is authoritative for upload and retention policy and publishes supported capabilities
and limits to launcher, module, addon, and helper. UI checks improve feedback but cannot bypass
backend enforcement. There must not be conflicting independent upload limits in each component.
Update reverse-proxy request limits consistently, accounting for encoding overhead if needed.
Prefer streamed binary uploads to large base64 JSON bodies.

### Lifecycle and deletion

1. Authenticate the uploader, enforce quotas, and stream into a bounded temporary location.
2. Validate actual format/signature and safe decode limits; reject malformed or disallowed files.
   Generate an opaque attachment ID and safe derived previews. Never use user filenames as paths.
3. Store ownership, size, format, creation time, expiry, conversation association, and derivative
   references. Keep original bytes outside publicly browsable static CDN paths.
4. Permit message attachment only after successful validation and authorization. Delete abandoned
   temporary uploads and expire unassociated uploads using the orphan policy.
5. Authorize each download against current conversation access. At expiry, reject new reads
   immediately even if physical cleanup has not run. Use authenticated delivery or tightly bounded
   signed URLs whose validity never exceeds attachment expiry.
6. A periodic idempotent worker deletes originals, previews, thumbnails, converted files, and other
   derivatives. Retry failures, record cleanup status, and catch up after downtime. Never delete
   outside the configured managed storage root.
7. Leave message text/history intact and render a shared `Attachment expired` placeholder. An
   expired attachment is not a broken-image error and cannot be resurrected by a retry.
8. Purge managed helper caches at expiry and use eviction when the cache budget is exceeded.
   Disconnect/reconnect must not reset the shelf life.

Logical availability ends at the expiry timestamp. Physical deletion normally completes within one
cleanup interval; failures must be observable rather than silently extending availability. Use a
storage lifecycle rule as an additional safeguard if the selected object store supports it.

Retention changes must be explicit: shortening the policy caps existing expiry at creation time
plus the new duration and immediately disables already-overdue attachments. Increasing retention
affects future uploads only; it does not restore expired/deleted media or extend existing files.
Publish policy changes so active clients refresh limits and expiry information.

Avoid shared original blobs across unrelated conversations in the initial implementation; this
keeps permission and deletion lifetimes independent. Configure CDN caching to prevent access after
expiry: use private/no-store responses initially, or bounded cache lifetimes plus verified purge
behavior. Updating a database row alone does not remove bytes cached at an edge.

Do not include ephemeral chat media in indefinite backups. If backups contain these files,
document and enforce their finite retention too, and prevent restores from republishing expired
media. Logs must not contain media bytes, passwords, tokens, or signed download URLs.

Server deletion cannot retract files a recipient deliberately saves, screenshots, or copies made
outside managed caches. State that boundary plainly in the owner documentation and user policy.
Avatar/header and community-post retention remain separate policies; reusing a media pipeline must
not accidentally expire unrelated profile assets or preserve expired chat attachments.

## Server-owner and player configuration

Provide a documented sample configuration with Esteria defaults and no hard-coded Esteria identity
in the protocol. Branding and supported policy changes should not require recompilation. New native
capabilities still require a versioned extension update.

| Area | Owner-controlled settings |
| --- | --- |
| Branding | Product name, logo, colors, packaged fonts/icons/sounds, default layout |
| Connection | Social API origin, server/realm IDs, approved media origins, service credentials |
| Identity | Verified linking policy, permitted account count, unlink/revocation behavior |
| Features | Direct chat, friends, groups, attachments, character presence, notifications |
| Media | Shelf life, upload limits, formats, quotas, decode limits, cleanup cadence |
| Moderation | Blocking, reporting, request/upload rates, message retention and audit policy |
| Distribution | Addon/helper/extension versions, update locations, minimum compatible versions |

Restrict security-sensitive settings and credentials to the backend/module. Send only sanitized
capabilities and presentation settings to clients. User preferences cover panel position/size,
UI scale, sounds, mute, autoplay, and privacy choices allowed by owner policy. Server-disabled
features cannot be re-enabled through SavedVariables.

## Implementation sequence

1. Define versioned capabilities, account-link flow, message/attachment schema, and retention policy.
   Preserve existing social data and launcher endpoints with a tested migration/rollback path.
2. Implement verified linking, scoped bridge/helper credentials, session-aware presence, and backend
   attachment upload/download/expiry/cleanup. Choose durable metadata storage suitable for concurrent
   requests and cleanup; existing JSON writes must not race or lose updates.
3. Add launcher attachment sending/rendering and expired-media behavior against the same API.
4. Implement the core module and addon text-chat parity using the shared service.
5. Package custom launcher-style addon assets and implement the native media/helper bridge.
6. Integrate image/GIF sending, avatars, inline placement, limits, and bounded caches in-game.
7. Ship owner configuration, deployment instructions, supported client requirements, and rollback
   instructions through the existing launcher addon/update distribution mechanisms.

## Acceptance gates

- Two distinct linked accounts exchange direct messages launcher-to-game, game-to-launcher, and
  game-to-game. Both interfaces show the same groups, history, unread state, and permissions.
- Test link expiry/reuse, spoofed identities, unauthorized attachments, unlink revocation, blocked
  senders, removed group members, and simultaneous launcher/game sessions.
- Verify appearance against the supplied screenshot and launcher at multiple resolutions/UI scales.
- Send and view images/GIFs from both interfaces; check scrolling, clipping, resizing, avatars,
  hidden animations, keyboard focus, relog, game exit, alt-tab, and renderer reset behavior.
- Closing the launcher leaves game chat and media working; stopping the helper gives a clear,
  recoverable media state without crashing WoW.
- Test upload limit boundaries, combined message limits, malformed media, oversized decoded frames,
  animation budgets, quota exhaustion, and cleanup of cancelled/failed uploads.
- Use a short shelf life to verify immediate download denial, expired placeholders, physical
  deletion of all derivatives, local cache purge, CDN behavior, cleanup retries after restart, and
  retention changes. Confirm backups/restores cannot republish expired attachments.
- Simulate service outages and retries; verify no duplicated sends, lost social data, false read
  receipts, or world-thread stalls.
- Validate packaged extension architecture/exports and client-image compatibility. Static/package
  checks are separate from successful live rendering and authenticated multi-client acceptance.

## Completion boundary

This document specifies the agreed implementation, including finite chat-media retention and
owner-configurable upload sizes. It does not authorize deployment or modification of `Wow.exe`.
Live UI/media behavior, native stability, and retention guarantees require the acceptance gates
above before the feature is declared complete.
