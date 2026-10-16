import { packageContext } from '../src/lib/platform.ts'
import { JWKS } from '../src/lib/jwks.ts'
import { getCaller, humanPlayer, type PlayerIdentity } from '../src/lib/identity.ts'
import { guestPlayer, ipHash, issueGuest, verifyGuest } from '../src/lib/guest.ts'
import { handlePublicApi, isPublicApiPath } from '../src/lib/public-api.ts'
import { signPowerSyncToken } from '../src/lib/token.ts'
import { POWERSYNC_URL } from '../src/lib/config.ts'
import { resetTiming, serverTiming, timed } from '../src/lib/timing.ts'
import {
	WorldError,
	applyBlockOps,
	parseBlockOp,
	requireWorldId,
	updateCursor,
	createRoom,
	getRoom,
	parseRoomRef,
	rateLimit,
	renameRoom,
	upsertPlayer,
	type BlockOp,
} from '../src/lib/world-ops.ts'
import { DEFAULT_WORLD_ID, LIMITS, blockId, cleanText } from '../src/shared/world-rules.ts'
import { renderShell } from './shell.ts'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, {
		status,
		headers: { 'cache-control': 'no-store', ...headers },
	})

function relPath(pathname: string) {
	const base = String(packageContext?.appBasePath ?? '')
		const assets = String(packageContext?.assetBasePath ?? `${base}/_assets`).replace(/\/+$/, '')
	if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length)
	return pathname.replace(/\/+$/, '') || '/'
}

type Actor = { player: PlayerIdentity; signedIn: boolean; ip: string }

/** The person behind a browser request: a Kody sign-in, else a signed guest token, else null. */
async function getActor(request: Request, preferSession = false): Promise<Actor | null> {
	const ip = await ipHash(request)
	if (preferSession) {
		const caller = await getCaller()
		if (caller) return { player: humanPlayer(caller), signedIn: true, ip }
	}
	// A valid guest token skips the Kody session lookup (the client drops its
	// guest token once signed in, so signed-in people aren't misread as guests).
	const guest = await timed('guest', () => verifyGuest(request.headers.get('x-wb-guest')))
	if (guest) return { player: guestPlayer(guest), signedIn: false, ip }
	const caller = preferSession ? null : await getCaller()
	return caller ? { player: humanPlayer(caller), signedIn: true, ip } : null
}

async function requireActor(request: Request) {
	const actor = await getActor(request)
	if (!actor) throw new WorldError('Reload the page to get a guest name, or sign in.', 401)
	return actor
}

/** Per-IP counters for people building without an account. */
function guestLimits(actor: Actor) {
	return actor.signedIn ? [] : [{ key: `ip-blocks:${actor.ip}`, limit: LIMITS.ipBlocksPerMinute }]
}

/** Actor for this request; mints a guest token when there is none. */
async function actorOrNewGuest(request: Request) {
	const actor = await getActor(request, true)
	if (actor) return { actor, guestToken: undefined as string | undefined }
	const { guest, token } = await issueGuest()
	return { actor: { player: guestPlayer(guest), signedIn: false, ip: await ipHash(request) }, guestToken: token }
}

function playerJson(player: PlayerIdentity) {
	return { id: player.id, displayName: player.displayName, color: player.color }
}

async function session(request: Request, url: URL) {
	const { actor, guestToken } = await actorOrNewGuest(request)
	const worldId = requireWorldId(url.searchParams.get('world'))
	let ready = true
	try {
		await upsertPlayer(actor.player, worldId)
	} catch (error) {
		ready = false
		console.warn('player upsert failed', error instanceof Error ? error.message : error)
	}
	return json({
		signedIn: actor.signedIn,
		guest: !actor.signedIn,
		...(guestToken ? { guestToken } : {}),
		ready,
		worldId,
		powersyncUrl: POWERSYNC_URL,
		player: playerJson(actor.player),
	})
}

function roomJson(room: { slug: string; name: string; id: string; ownerId: string }, ownerId: string | null) {
	return { slug: room.slug, name: room.name, worldId: room.id, isOwner: !!ownerId && room.ownerId === ownerId }
}

async function rooms(request: Request, path: string, method: string) {
	if (path === '/api/rooms' && method === 'POST') {
		const actor = await requireActor(request)
		if (!actor.signedIn) await rateLimit(`ip-rooms:${actor.ip}`, 1, LIMITS.ipRoomsPerMinute)
		return json({ room: roomJson(await createRoom(actor.player.ownerId), actor.player.ownerId) }, 201)
	}
	const slug = parseRoomRef(path.slice('/api/rooms/'.length))
	if (!slug) throw new WorldError('That room link is not valid.', 404)
	if (method === 'GET') {
		const actor = await getActor(request)
		try {
			return json({ room: roomJson(await getRoom(slug), actor?.player.ownerId ?? null) })
		} catch (error) {
			// Visitors read with the owner's opted-in database credential
			// (ownerCredentialForVisitors). If that isn't approved/effective yet,
			// explain instead of returning a generic error.
			if (!actor?.signedIn && !(error instanceof WorldError)) {
				throw new WorldError('This room could not load right now. Try again in a moment.', 503)
			}
			throw error
		}
	}
	if (method === 'PATCH') {
		const actor = await requireActor(request)
		const body = (await request.json().catch(() => null)) as { name?: unknown } | null
		return json({ room: roomJson(await renameRoom(slug, actor.player.ownerId, body?.name), actor.player.ownerId) })
	}
	return json({ error: 'Method not allowed' }, 405)
}

/**
 * PowerSync sync token. `sub` is the player id (`u:<username>` or `g:<uuid>`),
 * or a random spectator subject. A PowerSync token can only download (sync
 * rules are read-only buckets); every write goes through `POST /api/upload`,
 * which checks the Kody session or signed guest token.
 */
async function token(request: Request) {
	const actor = await getActor(request)
	const subject = actor ? actor.player.id : `anon:${crypto.randomUUID()}`
	try {
		return json({ ...(await signPowerSyncToken(subject)), readOnly: !actor })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error('world-builder token signing failed', message)
		// Signing errors describe configuration (approval, host), never key material.
		throw new WorldError(`Could not sign a sync token: ${message.slice(0, 300)}`, 503)
	}
}

type CrudOp = { op?: string; type?: string; id?: string; data?: Record<string, unknown> }

/** PowerSync uploadData target. Invalid ops are rejected (and revert on the client); a 429 asks the client to retry. */
async function upload(request: Request) {
	const actor = await requireActor(request)
	const player = actor.player
	const len = Number(request.headers.get('content-length') ?? 0)
	if (len > 256_000) throw new WorldError('Upload too large.', 413)
	const body = (await request.json().catch(() => null)) as { ops?: Array<CrudOp> } | null
	const ops = Array.isArray(body?.ops) ? body!.ops : []
	if (ops.length > LIMITS.maxUploadOps) throw new WorldError('Too many changes in one upload.', 413)

	const byWorld = new Map<string, Array<BlockOp>>()
	let rejected = 0
	let cursor: { worldId: string; pos: { x: number; y: number; z: number } | null } | null = null
	for (const op of ops) {
		if (op.type === 'blocks' && (op.op === 'PUT' || op.op === 'PATCH')) {
			const d = op.data ?? {}
			let worldId: string
			try {
				worldId = requireWorldId(d.world_id)
			} catch {
				rejected++
				continue
			}
			const parsed = parseBlockOp(d, 'put')
			if (!parsed || op.id !== blockId(worldId, parsed.x, parsed.y, parsed.z)) {
				rejected++
				continue
			}
			byWorld.set(worldId, [...(byWorld.get(worldId) ?? []), parsed])
		} else if (op.type === 'blocks' && op.op === 'DELETE') {
			const m = /^([0-9a-f-]{36}):(-?\d+):(-?\d+):(-?\d+)$/i.exec(String(op.id ?? ''))
			const parsed = m ? parseBlockOp({ x: m[2], y: m[3], z: m[4] }, 'del') : null
			if (!m || !parsed) {
				rejected++
				continue
			}
			const worldId = m[1]!.toLowerCase()
			byWorld.set(worldId, [...(byWorld.get(worldId) ?? []), parsed])
		} else if (op.type === 'players' && op.op === 'PATCH' && op.id === player.id) {
			const d = op.data ?? {}
			const has = d.cursor_x != null && d.cursor_y != null && d.cursor_z != null
			let worldId = DEFAULT_WORLD_ID
			try {
				worldId = requireWorldId(d.world_id)
			} catch {}
			cursor = {
				worldId,
				pos: has ? { x: Number(d.cursor_x), y: Number(d.cursor_y), z: Number(d.cursor_z) } : null,
			}
		} else {
			rejected++
		}
	}
	let placed = 0
	let removed = 0
	for (const [worldId, worldOps] of byWorld) {
		try {
			const out = await applyBlockOps({ player, worldId, ops: worldOps, extraLimits: guestLimits(actor) })
			placed += out.placed
			removed += out.removed
		} catch (error) {
			// 429 should be retried by the client; other world errors drop the ops.
			if (error instanceof WorldError && error.status !== 429) {
				rejected += worldOps.length
				continue
			}
			throw error
		}
	}
	if (cursor) {
		try {
			await updateCursor(player, cursor.worldId, cursor.pos)
		} catch (error) {
			if (!(error instanceof WorldError && error.status === 429)) throw error
		}
	}
	return json({ ok: true, placed, removed, rejected })
}

/** Fire-and-forget cursor sharing, kept off the PowerSync upload queue so block edits never wait behind it. */
async function cursorUpdate(request: Request) {
	const { player } = await requireActor(request)
	const body = (await request.json().catch(() => null)) as { worldId?: unknown; x?: unknown; y?: unknown; z?: unknown } | null
	const worldId = requireWorldId(body?.worldId)
	const has = body?.x != null && body?.y != null && body?.z != null
	await updateCursor(player, worldId, has ? { x: Number(body!.x), y: Number(body!.y), z: Number(body!.z) } : null)
	return json({ ok: true })
}

async function dispatch(request: Request) {
	const url = new URL(request.url)
	const path = relPath(url.pathname)
	const method = request.method.toUpperCase()

	if (path === '/health') return json({ ok: true, app: 'worlds-cloudflare' })
	if (path === '/.well-known/jwks.json' || path === '/jwks.json') {
		return json(JWKS, 200, { 'cache-control': 'public, max-age=300' })
	}
	if (isPublicApiPath(path)) return handlePublicApi(request, path, method, url)
	if (path === '/api/session' && method === 'GET') return session(request, url)
	if (path === '/api/me' && method === 'GET') {
		const { actor, guestToken } = await actorOrNewGuest(request)
		return json({
			signedIn: actor.signedIn,
			guest: !actor.signedIn,
			displayName: actor.player.displayName,
			...(guestToken ? { guestToken } : {}),
		})
	}
	if (path === '/api/name' && method === 'POST') {
		// No accounts: visitors just pick a name. Keeps the same guest id on rename.
		const body = (await request.json().catch(() => null)) as { name?: unknown } | null
		const name = cleanText(body?.name, 40)
		if (!name) throw new WorldError('Pick a name (1-40 characters).', 400)
		const ip = await ipHash(request)
		await rateLimit(`ip-names:${ip}`, 1, 20)
		const current = await verifyGuest(request.headers.get('x-wb-guest'))
		const { guest, token: guestToken } = await issueGuest({ name, id: current?.id })
		return json({ guestToken, displayName: guest.name, id: guest.id })
	}
	if (path === '/api/token' && method === 'GET') return token(request)
	if (path === '/api/cursor') {
		if (method !== 'POST') return json({ error: 'Method not allowed' }, 405)
		return cursorUpdate(request)
	}
	if (path === '/api/upload') {
		if (method !== 'POST') return json({ error: 'Method not allowed' }, 405)
		return upload(request)
	}
	if (path === '/api/rooms' || path.startsWith('/api/rooms/')) return rooms(request, path, method)
	if (path === '/manifest.webmanifest') {
		const base = String(packageContext?.appBasePath ?? '')
		const assets = String(packageContext?.assetBasePath ?? `${base}/_assets`)
		return json(
			{
				name: 'World Builder',
				short_name: 'World Builder',
				start_url: `${base}/`,
				scope: `${base}/`,
				display: 'standalone',
				background_color: '#0f1420',
				theme_color: '#0f1420',
				icons: [{ src: `${assets}/icon.png`, sizes: '512x512', type: 'image/png' }],
			},
			200,
			{ 'content-type': 'application/manifest+json' },
		)
	}
	if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404)
	if (method === 'GET' || method === 'HEAD') return renderShell()
	return new Response('Method Not Allowed', { status: 405 })
}

export default {
	async fetch(request: Request) {
		resetTiming()
		let response: Response
		try {
			response = await dispatch(request)
		} catch (error) {
			if (error instanceof WorldError) response = json({ error: error.message }, error.status)
			else {
				console.error('world-builder request failed', error instanceof Error ? error.message : error)
				response = json({ error: 'Something went wrong. Try again.' }, 500)
			}
		}
		// Durations and counts only (cred, neon, caller, guest, app); no values.
		const timing = serverTiming()
		const path = relPath(new URL(request.url).pathname)
		if (path.startsWith('/api')) console.log(`timing ${request.method} ${path.slice(0, 60)} ${response.status} ${timing}`)
		try {
			response.headers.set('server-timing', timing)
			return response
		} catch {
			const copy = new Response(response.body, response)
			copy.headers.set('server-timing', timing)
			return copy
		}
	},
}
