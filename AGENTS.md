# @kentcdodds/world-builder — agent notes

Human intent lives in [README.md](./README.md). This is the agent runbook.

## Building in the world (for agents)

Agents build through the app's **public HTTP API**. No Kody account, no API key.
Live docs (generated from the code, always current): `https://worlds.kentcdodds.com/llms.txt`
(Markdown) and `/api` (HTML). Source: `src/lib/public-api.ts`.

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/v1/rooms/:room` | Summary: rules, blockCount, occupiedBounds, 8×8 heightMap, recentBuilds |
| GET | `/api/v1/rooms/:room/blocks` | `?minX&maxX&minY&maxY&minZ&maxZ&limit` (≤5000) |
| POST | `/api/v1/rooms/:room/blocks` | `{ agent, place?: [{x,y,z,material}], remove?: [{x,y,z}], buildId? }` (≤600 changes) |
| POST | `/api/v1/rooms/:room/builds` | `{ agent, prompt }` → `{ buildId }` |
| POST | `/api/v1/builds/:buildId/finish` | `{ status?: 'done' \| 'failed' }` |
| POST | `/api/v1/rooms` | `{ agent? }` → `{ room, url }` |

```sh
curl -s -X POST https://worlds.kentcdodds.com/api/v1/rooms/main/blocks \
  -H 'content-type: application/json' \
  -d '{"agent":"Claude","place":[{"x":0,"y":0,"z":0,"material":"stone"}]}'
```

- Agent identity is `a:ip-<hash>:<slug(agent)>` with owner `ip:<sha256(ip) prefix>` (raw IPs are never stored). Holding a `buildId` is the permission to write to / finish that build.
- Limits (`LIMITS` in `src/shared/world-rules.ts`): 600 changes per request, 2400/min per agent, 3000/min per IP and per owner, 900/min per human, 60000 blocks per room (checked with an early-exit index scan, not `count(*)`), 5 rooms/min per IP. 429 = slow down, 409 = room full.
- Every write is one Neon transaction (`applyBlockOps`): rate-limit counters, size check, write. CORS is `*` for `/api/v1/*`, `/api`, `/llms.txt`.
- The room page's **Copy prompt for your agent** button builds the prompt in `src/shared/agent-prompt.ts`. Keep it in sync with the API.

### Read-only Kody exports (kept)

| Export | Import | Input |
| --- | --- | --- |
| list-worlds | `kody:@kentcdodds/world-builder/list-worlds` | — (signed-in Kody caller) |
| describe-world | `kody:@kentcdodds/world-builder/describe-world` | `{ room, region? }` |

The old Kody write exports (create-world, start-build, place-blocks, remove-blocks, finish-build, build-demo-castle) were removed; use the HTTP API.

Smoke (read-only): `curl -s https://worlds.kentcdodds.com/api/v1/rooms/main | head -c 400`

## Architecture

- **Source DB:** Neon Postgres `kody-world-builder` (project `lingering-moon-00789441`, aws-us-west-2), logical replication on.
  Tables `worlds`, `players`, `builds`, `blocks` (+ `rate_limits`, not replicated). Publication `powersync`.
  Block id is `${worldId}:${x}:${y}:${z}` so each cell has one block (last write wins).
- **PowerSync Cloud:** org kentcdodds, project `kody-world-builder`, instance `dev`
  (`https://6ad125492f27853eb0af53b6.powersync.journeyapps.com`), replication role `powersync_role`.
  Sync rules: `powersync/sync-rules.yaml` (bucket per world).
  Client auth: inline JWKS with `kid wb-QFJN0o8I-4Vp` (same key as `src/lib/jwks.ts`; also served at `/.well-known/jwks.json`).
- **App Worker** (`app/server.ts`):
  - `GET /api/session` — Kody visitor → player row (`u:<username>`).
  - `GET /api/token` — signs a 5-minute RS256 token (`sub` = player id, `aud` = instance URL) via `credential('powersync-jwt').sign`.
  - `POST /api/upload` — PowerSync `uploadData` target. Validates every op: only `blocks` PUT/PATCH/DELETE with id matching coords and in bounds, known material; `players` PATCH only for your own row (legacy cursor path). Invalid ops are dropped (reverted by the next checkpoint). 429 → client retries.
  - `GET /.well-known/jwks.json` — public key.
- **DB access:** `src/lib/db.ts` POSTs to Neon's HTTPS `/sql` endpoint via `credential('neon-postgres')`, which injects the `Neon-Connection-String` header (TCP 5432 isn't available from Workers or the box).
- **Client** (`app/client/*`): React 19 + @react-three/fiber + three.js; `@powersync/web` with the prebuilt worker in `public/powersync/` (wa-sqlite wasm). One InstancedMesh per material; new blocks drop in with a 380 ms ease. Agent markers float over each active agent's latest block. Human cursors are posted to `/api/cursor` every 350 ms (when moved) and sync back through `players.cursor_*`.

## Credentials (by name)

- `neon-world-builder-db` → need `neon-postgres`. Key, inject `Neon-Connection-String: {value}`. Host approval: https://kody.codes/connect/secrets?name=neon-world-builder-db&hosts=ep-lingering-king-ardkhzrz.c-4.us-west-2.aws.neon.tech
- `world-builder-powersync-jwt` → need `powersync-jwt`. Signing, host `6ad125492f27853eb0af53b6.powersync.journeyapps.com`.

Rotate the signing key: generate a new RSA key, save it with `secretSet` (kind `signing`), add the new public JWK alongside the old one in `src/lib/jwks.ts` and the instance client auth, publish, then drop the old key.

## Gotchas

- Guests: login is optional. Without a Kody session, `/api/session` and `/api/me` mint a guest (`g:<uuid>`, random name) as an RS256 token signed with the existing `powersync-jwt` credential (claim `wb: 'guest'`, 90 days) and verified with `src/lib/jwks.ts` (`src/lib/guest.ts`). The browser stores it in localStorage (`wb-guest-token`) and sends it as `x-wb-guest` on `/api/token`, `/api/upload`, `/api/cursor`, `/api/rooms`. Guests also get per-IP block and room limits. PowerSync tokens only download; every write goes through the app's validated endpoints.
- Cursors: `POST /api/cursor` (fire-and-forget, off the PowerSync upload queue).
- Sign out links to the platform's `/_kody/auth/logout?return_to=…` (same as package-app-kit `auth.logoutUrl`). It clears the host's `__Host-kody_pkg_session` cookie, so on `kentcdodds.kody.run` it signs you out of every package app on that host.
- Only org members of `@kentcdodds` resolve as signed-in visitors on a private app.
- `public/powersync/` must match the installed `@powersync/web` version (copy `node_modules/@powersync/web/dist/worker/*` minus the `mc-*` encryption builds when upgrading).

## Client bundle

The browser client is prebuilt (the npm graph is too large for Kody's in-isolate bundler). After editing `app/client/*`, run `npm run build:client` and commit `public/client/main.js`. Runtime npm deps live in `devDependencies` on purpose.

## Rooms

- `worlds.slug` is the room code: 10 characters from a 31-letter alphabet (about 49 bits), with a unique index. The main world's code is `main`.
- `worlds.created_by` is the owner id: Kody username, guest id `g:<uuid>`, or `ip:<hash>` for API-created rooms. Only the owner can rename (`PATCH /api/rooms/<code>`).
- Routes: `POST /api/rooms` (create, 10 per minute per person, 5 per minute per IP for guests), `GET /api/rooms/<code>`, `GET /api/me`. The client routes `/` to the landing page and `/r/<code>` to a room.
- Sync rules use the `world_id` client parameter (`request.parameters()`), and the client connects with `params: { world_id }`. A browser only syncs the room it opened.
