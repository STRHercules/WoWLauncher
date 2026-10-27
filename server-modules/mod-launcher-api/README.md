# mod-launcher-api

Standalone AzerothCore module that gives a game launcher an HTTP API for:

- **Account creation** - creates a normal game account (name, password, email). The same login works in the launcher and the game client.
- **Account management** - change password and email.
- **Characters** - list, soft-delete / restore, and the rename, faction change, race change and re-customize services.
- **Armory and world database** - public, read-only, live lookups of characters with gear, and of items, quests, NPCs, spells and zones.
- **Presence** - which character an account is playing right now (name, level, race, class, zone).

No SQL and no extra tables. Services reuse the core `at_login` flags, delete/restore reuse the core soft-delete path.

## Install

1. Copy this folder to `azerothcore/modules/mod-launcher-api`.
2. Re-run CMake and rebuild worldserver.
3. Copy `conf/mod_launcher_api.conf.dist` to `mod_launcher_api.conf` next to `worldserver.conf`, set `LauncherApi.Enable = 1`.
4. Open the port (default `8095`). For public servers either set `LauncherApi.Tls.Cert/Key` or put Caddy/nginx with HTTPS in front and keep `Bind = 127.0.0.1`.

Requires an AzerothCore build with Boost.Beast and OpenSSL (any current master).

## API

JSON in/out under `/launcher/v1/`. `login` returns a bearer token; send it as `Authorization: Bearer <token>`.

| Route | Body | Notes |
|-------|------|-------|
| `GET info` | | registration / service flags |
| `POST register` | `username, password, email` | name 3-17 alnum, password 6-16 |
| `POST login` | `username, password` | -> `token` |
| `POST logout` | | |
| `GET me` | | username, email |
| `POST password` | `current, new` | |
| `POST email` | `password, email` | |
| `GET characters` | | `characters[]` and `deleted[]` |
| `POST characters/<guid>/delete` | | blocked for guild leaders / arena captains / online |
| `POST characters/<guid>/restore` | | needs a free slot and unused name |
| `POST characters/<guid>/service` | `service: rename\|customize\|faction\|race` | sets `at_login`; player finishes at character select |
| `GET armory?q=` | | public; characters with gear (100 per search, 250 without). Bots hidden unless `LauncherApi.Armory.IncludeBots = 1` |
| `GET database?q=&type=` | | public; `type` = item, quest, npc, spell, zone or all. Answers are cached 60 s and limited to 120 lookups/min per IP |
| `GET presence` | | `{online, character{name, level, race, class, zone, map}}` |

## Limits

- Services are free. Charge for them with your own economy module if you want.
- Throttling is per connecting IP (5 registrations/hour, 10 failed logins/10 min); behind a reverse proxy that is the proxy's IP.
- Tokens live in memory; a worldserver restart signs launchers out.
