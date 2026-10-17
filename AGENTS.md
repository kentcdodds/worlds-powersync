# worlds-cloudflare — agent notes

Human intent lives in [README.md](./README.md). This is the agent runbook.

Standalone Cloudflare Workers fork of `@kentcdodds/world-builder`: no Kody runtime,
no sign-in. One Worker (`worlds-cloudflare`) serves the static client and the API,
Neon Postgres is the source of truth, and PowerSync Cloud streams rooms to browsers.

Live: https://worlds.kentcdodds.com

## Building in the world (for agents)

Agents build through the app's **public HTTP API**. No account, no API key.
Live docs (generated from the code, always current): `/llms.txt` (Markdown) and `/api` (HTML).
Source: `src/lib/public-api.ts`.

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/v1/rooms/:room` | Summary: rules, blockCount, occupiedBounds, heightMap, recentBuilds |
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

- Agent identity is `a:ip-<hash>:<slug(agent)>` with owner `ip:<hash>` (SHA-256 of the client IP from `cf-connecting-ip`; raw IPs are never stored). Holding a `buildId` is the permission to write to / finish that build.
- Limits (`LIMITS` in `src/shared/world-rules.ts`): 600 changes per request, 2400/min per agent, 3000/min per IP and per owner, 900/min per human, 60000 blocks per room, 5 rooms/min per IP. 429 = slow down, 409 = room full.
- Every write is one Neon transaction (`applyBlockOps` in `src/lib/world-ops.ts`): rate-limit counters, size check, write. CORS is `*` for `/api/v1/*`, `/api`, `/llms.txt`.
- The room page's **Copy prompt for your agent** button builds the prompt in `src/shared/agent-prompt.ts`. Keep it in sync with the API.

Smoke (read-only): `curl -s https://worlds.kentcdodds.com/api/v1/rooms/main | head -c 400`
and `curl -s https://worlds.kentcdodds.com/health`.

## Architecture

- **Worker** (`wrangler.jsonc`, entry `app/server.ts`): Workers Assets serves `public/` (binding `ASSETS`), smart placement keeps the Worker near Neon (aws-us-west-2), `nodejs_compat`, observability on.
- **Platform glue** (`src/lib/platform.ts`): replaces the Kody runtime with the same shapes the app code was written against.
  - `credential('neon-postgres').fetch` POSTs to Neon's HTTPS `/sql` endpoint (host derived from `DATABASE_URL`) with the `Neon-Connection-String` header. TCP 5432 is not used.
  - `credential('powersync-jwt').sign` signs RS256 JWTs with `POWERSYNC_PRIVATE_KEY` via WebCrypto.
  - `kody.metaGetCurrentUser` always returns no user: there is no sign-in, so every person is a named guest. (`src/lib/identity.ts` still carries the unused signed-in path.)
- **Source DB:** Neon project `lingering-moon-00789441`, branch `cloudflare-fork` (separate compute/data from the original app's `main` branch), logical replication on.
  Tables `worlds`, `players`, `builds`, `blocks` (+ `rate_limits`, not replicated). Publication `powersync`.
  Block id is `${worldId}:${x}:${y}:${z}` so each cell has one block (last write wins).
- **PowerSync Cloud:** instance `cloudflare-fork` (`https://6ad296de3b1803753bd2489f.powersync.journeyapps.com`, `POWERSYNC_URL` in `src/lib/config.ts`).
  Sync rules: `powersync/sync-rules.yaml` (one bucket per room via the `world_id` client parameter).
  Client auth: inline JWKS with `kid wbcf-kvyZnGEyy6` (same public key as `src/lib/jwks.ts`; also served at `/.well-known/jwks.json`).
- **Routes** (`app/server.ts`):
  - `GET /api/session?world=<id>` and `GET /api/me` — resolve the guest (or mint one) and upsert the player row.
  - `POST /api/name` — pick/rename your guest name (1–40 chars, 20/min per IP); keeps the same guest id and returns a fresh token.
  - `GET /api/token` — 5-minute RS256 PowerSync token (`sub` = player id, `aud` = instance URL). Without a guest token you get a read-only `anon:<uuid>` subject.
  - `POST /api/upload` — PowerSync `uploadData` target. Validates every op: only `blocks` PUT/PATCH/DELETE with id matching coords, in bounds, known material; `players` PATCH only for your own row (legacy cursor path). Invalid ops are dropped (reverted by the next checkpoint). 429 → client retries.
  - `POST /api/cursor` — fire-and-forget cursor sharing, off the PowerSync upload queue.
  - `POST /api/rooms`, `GET`/`PATCH /api/rooms/<code>` — create, read, rename (owner only).
  - `GET /.well-known/jwks.json`, `GET /health`, `/manifest.webmanifest`; any other GET renders the app shell (`app/shell.ts`).
- **Client** (`app/client/*`): React 19 + @react-three/fiber + three.js; `@powersync/web` with the prebuilt worker in `public/powersync/` (wa-sqlite wasm). One InstancedMesh per material; new blocks drop in with an ease. Agent markers float over each active agent's latest block. Cursors are posted every 200 ms (when moved) and remote cursors ease between updates.

## Secrets (by name only)

Set with `wrangler secret put <NAME>`; never commit values. Local dev values go in `.dev.vars` (gitignored).

| Secret | What |
| --- | --- |
| `DATABASE_URL` | Neon connection string for the `cloudflare-fork` branch |
| `POWERSYNC_PRIVATE_KEY` | PKCS#8 PEM of the RS256 signing key whose public half is in `src/lib/jwks.ts` |

Rotate the signing key: generate a new RSA key, add its public JWK to the PowerSync instance's client auth, put it in `src/lib/jwks.ts` and update `JWT_KID` in `src/lib/config.ts`, `wrangler secret put POWERSYNC_PRIVATE_KEY`, deploy, then remove the old key from the instance. Guest tokens are verified against `JWKS.keys[0]` and `JWT_KID` only, so rotating invalidates existing guest tokens (guests get new identities).

## Develop / deploy

```sh
npm install
npm run build:client   # bundles app/client -> public/client/main.js (commit it)
npx wrangler deploy    # or: npm run deploy (builds the client, then deploys)
```

The browser client is prebuilt and committed; after editing `app/client/*`, run `npm run build:client` and commit `public/client/main.js`. Runtime npm deps live in `devDependencies` on purpose (only the bundle ships).

## Gotchas

- Guests: everyone is a guest (`g:<uuid>`, random or chosen name) holding a 90-day RS256 token signed with `POWERSYNC_PRIVATE_KEY` (claim `wb: 'guest'`) and verified with `src/lib/jwks.ts` (`src/lib/guest.ts`). The browser stores it in localStorage and sends it as `x-wb-guest` on `/api/token`, `/api/upload`, `/api/cursor`, `/api/rooms`, `/api/name`. Guests get per-IP block and room limits. PowerSync tokens only download; every write goes through the app's validated endpoints.
- `public/powersync/` must match the installed `@powersync/web` version (copy `node_modules/@powersync/web/dist/worker/*` minus the `mc-*` encryption builds when upgrading).
- `.kody/icon.png` and some "Kody World Builder" strings (docs text, agent prompt, local SQLite filename) are leftovers from the original app; harmless.

## Rooms

- `worlds.slug` is the room code: 10 characters from a 31-letter alphabet (about 49 bits), with a unique index. The main world's code is `main`.
- `worlds.created_by` is the owner id: guest id `g:<uuid>`, or `ip:<hash>` for API-created rooms. Only the owner can rename (`PATCH /api/rooms/<code>`).
- The client routes `/` to the landing page and `/r/<code>` to a room. It connects to PowerSync with `params: { world_id }`, so a browser only syncs the room it opened.
