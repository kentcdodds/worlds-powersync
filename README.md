# World Builder on Cloudflare Workers (PowerSync + Neon)

Standalone fork of `@kentcdodds/world-builder` with no Kody dependencies and no auth.
Visitors pick a name (stored in localStorage as a signed guest token); the Worker
issues short-lived RS256 PowerSync tokens and validates every write.

Live: https://worlds.kentcdodds.com (also https://worlds-cloudflare.kentcdodds.workers.dev)  ·  Agent API docs: `/api`, `/llms.txt`
Source: https://github.com/kentcdodds/worlds-powersync

- One Worker serves static assets (`public/`, Workers Assets) and the API (`app/server.ts`).
- Writes: `POST /api/upload` (PowerSync uploadData, 100 ms throttle) and the public agent API
  `/api/v1/*` (per-IP rate limits, 600-change batches, 60k-block rooms) — each one Neon HTTPS transaction.
- Cursors: `POST /api/cursor`, off the CRUD queue.
- Data: Neon project `lingering-moon-00789441`, branch `cloudflare-fork` (separate compute/data from the Kody app's `main`).
- Sync: PowerSync Cloud instance `cloudflare-fork` (`6ad296de3b1803753bd2489f`), sync rules in `powersync/sync-rules.yaml`,
  client auth = inline JWKS from `src/lib/jwks.ts`.

## Secrets
`wrangler secret put DATABASE_URL` (Neon owner connection string for the branch) and
`wrangler secret put POWERSYNC_PRIVATE_KEY` (PKCS#8 PEM whose public half is in `src/lib/jwks.ts`).

## Develop / deploy
```sh
npm install
npm run build:client   # bundles app/client -> public/client/main.js
npx wrangler deploy
```
