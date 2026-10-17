import { packageContext } from './platform.ts'
import { BOUNDS, LIMITS, MATERIAL_KEYS, SOURCE_URL } from '../shared/world-rules.ts'
import { apiAgentPlayer, ipHash } from './guest.ts'
import {
	WorldError,
	applyBlockOps,
	createRoom,
	describeWorld,
	finishBuild,
	getBuild,
	getRoom,
	roomIdForSlug,
	parseBlockOp,
	parseRoomRef,
	rateLimit,
	regionBlocks,
	requireUuid,
	startBuild,
	type BlockOp,
} from './world-ops.ts'

/**
 * Public HTTP API for agents. No account or API key: an agent picks a label
 * (`agent`), and limits apply per agent label and per IP address. CORS is open.
 */

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'content-type',
	'access-control-max-age': '86400',
}

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store', ...CORS } })

const text = (body: string, type: string) =>
	new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'public, max-age=300', ...CORS } })

export function isPublicApiPath(path: string) {
	return path === '/api' || path === '/api/docs' || path === '/llms.txt' || path === '/api/v1' || path.startsWith('/api/v1/')
}

function baseUrl(url: URL) {
	return `${url.origin}${String(packageContext?.appBasePath ?? '')}`
}

async function readJson(request: Request) {
	const len = Number(request.headers.get('content-length') ?? 0)
	if (len > 200_000) throw new WorldError('Request body too large.', 413)
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorldError('Send a JSON object body.')
	return body
}

const int = (v: string | null, fallback: number) => {
	const n = Number(v)
	return v != null && v !== '' && Number.isFinite(n) ? Math.trunc(n) : fallback
}

export async function handlePublicApi(request: Request, path: string, method: string, url: URL): Promise<Response> {
	if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
	try {
		return await route(request, path, method, url)
	} catch (error) {
		if (error instanceof WorldError) return json({ error: error.message }, error.status)
		console.error('world-builder api failed', error instanceof Error ? error.message : error)
		return json({ error: 'Something went wrong. Try again.' }, 500)
	}
}

async function route(request: Request, path: string, method: string, url: URL): Promise<Response> {
	const base = baseUrl(url)
	if (path === '/api' && method === 'GET') return text(docsHtml(base), 'text/html')
	if ((path === '/api/docs' || path === '/llms.txt') && method === 'GET') return text(docsMarkdown(base), 'text/markdown')
	if (path === '/api/v1' && method === 'GET') {
		return json({ docs: `${base}/api/docs`, html: `${base}/api`, rules: rules() })
	}
	if (path === '/api/v1/rooms' && method === 'POST') {
		const body = await readJson(request).catch(() => ({}) as Record<string, unknown>)
		const ip = await ipHash(request)
		await rateLimit(`ip-rooms:${ip}`, 1, LIMITS.ipRoomsPerMinute)
		const player = apiAgentPlayer(body.agent, ip)
		const room = await createRoom(player.ownerId)
		return json({ room: room.slug, name: room.name, url: `${base}/r/${room.slug}` }, 201)
	}
	let m = /^\/api\/v1\/builds\/([0-9a-f-]{36})\/finish$/i.exec(path)
	if (m && method === 'POST') {
		const body = await readJson(request).catch(() => ({}) as Record<string, unknown>)
		const build = await getBuild(requireUuid(m[1], 'buildId'))
		const status = body.status === 'failed' ? 'failed' : 'done'
		await finishBuild(build.id, status)
		return json({ buildId: build.id, status })
	}
	m = /^\/api\/v1\/rooms\/([^/]+)(\/blocks|\/builds)?$/.exec(path)
	if (!m) return json({ error: `Not found. See ${base}/api/docs` }, 404)
	const slug = parseRoomRef(decodeURIComponent(m[1]!))
	if (!slug) throw new WorldError('Room must be a room code like "main" or a room link.', 404)
	const sub = m[2] ?? ''
	if (sub === '/blocks' && method === 'POST') return writeBlocks(request, await roomIdForSlug(slug), slug)
	const room = await getRoom(slug)

	if (sub === '' && method === 'GET') {
		const info = await describeWorld(room.id)
		return json({ room: room.slug, url: `${base}/r/${room.slug}`, ...info })
	}
	if (sub === '/blocks' && method === 'GET') {
		const q = url.searchParams
		const region = {
			minX: int(q.get('minX'), BOUNDS.minX),
			maxX: int(q.get('maxX'), BOUNDS.maxX),
			minY: int(q.get('minY'), BOUNDS.minY),
			maxY: int(q.get('maxY'), BOUNDS.maxY),
			minZ: int(q.get('minZ'), BOUNDS.minZ),
			maxZ: int(q.get('maxZ'), BOUNDS.maxZ),
		}
		const limit = Math.max(1, Math.min(5000, int(q.get('limit'), 5000)))
		const blocks = await regionBlocks(room.id, region, limit)
		return json({ room: room.slug, region, count: blocks.length, truncated: blocks.length === limit, blocks })
	}
	if (sub === '/builds' && method === 'POST') {
		const body = await readJson(request)
		const ip = await ipHash(request)
		await rateLimit(`ip-builds:${ip}`, 1, 30)
		const player = apiAgentPlayer(body.agent, ip)
		const buildId = await startBuild(player, room.id, body.prompt)
		return json({ buildId, room: room.slug, agent: player.displayName }, 201)
	}
	return json({ error: 'Method not allowed' }, 405)
}

async function writeBlocks(request: Request, worldId: string, slug: string) {
	const body = await readJson(request)
	const ip = await ipHash(request)
	const place = body.place ?? body.blocks
	const remove = body.remove
	if (place != null && !Array.isArray(place)) throw new WorldError('place must be an array of {x, y, z, material}.')
	if (remove != null && !Array.isArray(remove)) throw new WorldError('remove must be an array of {x, y, z}.')
	const total = (place?.length ?? 0) + (remove?.length ?? 0)
	if (total === 0) throw new WorldError('Send place: [{x, y, z, material}] and/or remove: [{x, y, z}].')
	if (total > LIMITS.maxApiOpsPerCall) {
		throw new WorldError(`At most ${LIMITS.maxApiOpsPerCall} block changes per request. Split into several requests.`, 413)
	}

	let player = apiAgentPlayer(body.agent, ip)
	let buildId: string | null = null
	if (body.buildId != null) {
		const build = await getBuild(requireUuid(body.buildId, 'buildId'))
		if (build.worldId !== worldId) throw new WorldError('That build belongs to a different room.', 409)
		if (build.status === 'done' || build.status === 'failed') throw new WorldError('That build is finished. Start a new build.', 409)
		player = build.player
		buildId = build.id
	}

	const ops: Array<BlockOp> = []
	let rejected = 0
	for (const raw of (place ?? []) as Array<unknown>) {
		const op = parseBlockOp(raw, 'put')
		if (op) ops.push(op)
		else rejected++
	}
	for (const raw of (remove ?? []) as Array<unknown>) {
		const op = parseBlockOp(raw, 'del')
		if (op) ops.push(op)
		else rejected++
	}
	const extraLimits = [{ key: `ip-blocks:${ip}`, limit: LIMITS.ipBlocksPerMinute }]
	let placed = 0
	let removed = 0
	// Chunks of 200 keep each transaction small; viewers see each chunk land.
	for (let i = 0; i < ops.length; i += LIMITS.maxUploadOps) {
		const out = await applyBlockOps({
			player,
			worldId,
			ops: ops.slice(i, i + LIMITS.maxUploadOps),
			buildId,
			extraLimits,
			upsertPlayer: !buildId,
		})
		placed += out.placed
		removed += out.removed
	}
	return json({ ok: true, room: slug, agent: player.displayName, placed, removed, rejected })
}

function rules() {
	return {
		bounds: BOUNDS,
		yIsUp: true,
		groundLevel: 0,
		materials: [...MATERIAL_KEYS],
		maxBlockChangesPerRequest: LIMITS.maxApiOpsPerCall,
		blockChangesPerMinute: { perAgent: LIMITS.agentBlocksPerMinute, perIp: LIMITS.ipBlocksPerMinute },
		maxBlocksPerRoom: LIMITS.maxBlocksPerWorld,
		roomsPerMinutePerIp: LIMITS.ipRoomsPerMinute,
	}
}

export function docsMarkdown(base: string) {
	const mats = [...MATERIAL_KEYS].join(', ')
	return `# Kody World Builder: HTTP API for agents

A shared 3D voxel world. Anyone can build, and so can your agent. No account and no API key.
Everyone watching a room sees your blocks appear live.

Base URL: ${base}/api/v1
Watch a room: ${base}/r/<room>   (the main world's room code is \`main\`)
Source code: ${SOURCE_URL}

## Quick start

\`\`\`sh
# 1. Look at the room (bounds, materials, height map, recent builds)
curl -s ${base}/api/v1/rooms/main

# 2. Place blocks (send your name as "agent"; you show up under it)
curl -s -X POST ${base}/api/v1/rooms/main/blocks \\
  -H 'content-type: application/json' \\
  -d '{"agent":"Claude","place":[{"x":0,"y":0,"z":0,"material":"stone"},{"x":0,"y":1,"z":0,"material":"glass"}]}'

# 3. Remove blocks
curl -s -X POST ${base}/api/v1/rooms/main/blocks \\
  -H 'content-type: application/json' \\
  -d '{"agent":"Claude","remove":[{"x":0,"y":1,"z":0}]}'
\`\`\`

## Endpoints

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | /api/v1/rooms/:room | — | Room summary: \`rules\`, \`blockCount\`, \`occupiedBounds\`, 8×8 \`heightMap\` (-1 = empty), \`recentBuilds\` |
| GET | /api/v1/rooms/:room/blocks | \`?minX&maxX&minY&maxY&minZ&maxZ&limit\` (limit ≤ 5000) | Exact blocks in the box |
| POST | /api/v1/rooms/:room/blocks | \`{ agent, place?: [{x,y,z,material}], remove?: [{x,y,z}], buildId? }\` | \`{ placed, removed, rejected }\` |
| POST | /api/v1/rooms/:room/builds | \`{ agent, prompt }\` | \`{ buildId }\`: shows "<agent>: <prompt>" in the room's build feed |
| POST | /api/v1/builds/:buildId/finish | \`{ status?: "done" \\| "failed" }\` | Marks the build finished |
| POST | /api/v1/rooms | \`{ agent? }\` | \`{ room, url }\`: a new empty room |

\`:room\` is a room code (e.g. \`main\`) or a URL-encoded room link. Pass \`buildId\` on block writes to attribute them to a build.

## World rules

- y is up and the ground is y = 0. x: ${BOUNDS.minX}..${BOUNDS.maxX}, z: ${BOUNDS.minZ}..${BOUNDS.maxZ}, y: ${BOUNDS.minY}..${BOUNDS.maxY}. Integers only.
- Materials: ${mats}.
- One block per cell; placing over a block replaces it.
- Out-of-bounds blocks or unknown materials are skipped and counted in \`rejected\`.

## Limits

- ${LIMITS.maxApiOpsPerCall} block changes per request.
- ${LIMITS.agentBlocksPerMinute} block changes per minute per agent name, ${LIMITS.ipBlocksPerMinute} per minute per IP address.
- ${LIMITS.maxBlocksPerWorld.toLocaleString('en-US')} blocks per room; ${LIMITS.ipRoomsPerMinute} new rooms per minute per IP.
- Over a limit you get HTTP 429 ("Slow down"); wait a few seconds and continue where you stopped. A full room returns 409.

## Tips

- Plan the structure in code (loops for walls, floors, towers), then send it bottom-up in chunks of a few hundred blocks so people watch it rise.
- Check \`heightMap\` first and build in an empty spot. Don't build over other people's work unless asked.
- A good castle is about 20×20 and 900–1,200 blocks.
- CORS is open, so browser-based agents can call the API directly.
`
}

const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z'

function docsHtml(base: string) {
	const md = docsMarkdown(base)
	const esc = md.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
	return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>World Builder API</title>
<style>body{margin:0;background:#0f1420;color:#e6ebf5;font:15px/1.55 ui-sans-serif,system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:32px 20px}pre{white-space:pre-wrap;background:#161d2e;border:1px solid #273148;border-radius:10px;padding:18px;font:13px/1.5 ui-monospace,Menlo,monospace}a{color:#8fb4ff}</style>
</head><body><main><h1>Let your agent build</h1>
<p>Paste this page's link into your agent, or point it at <a href="${base}/llms.txt">${base}/llms.txt</a> (Markdown). <a href="${base}/">Back to World Builder</a></p>
<p><a href="${SOURCE_URL}" style="display:inline-flex;align-items:center;gap:6px"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${GITHUB_PATH}"/></svg>Source code</a></p>
<pre>${esc}</pre></main></body></html>`
}

