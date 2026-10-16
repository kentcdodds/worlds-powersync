import {
	BOUNDS,
	DEFAULT_WORLD_ID,
	LIMITS,
	MATERIAL_KEYS,
	blockId,
	cleanText,
	inBounds,
} from '../shared/world-rules.ts'
import { num, sql, transaction, type Query } from './db.ts'
import type { PlayerIdentity } from './identity.ts'

export class WorldError extends Error {
	status: number
	constructor(message: string, status = 400) {
		super(message)
		this.status = status
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function requireWorldId(value: unknown) {
	const id = value == null || value === '' ? DEFAULT_WORLD_ID : String(value)
	if (!UUID.test(id)) throw new WorldError('worldId must be a world id from listWorlds.')
	return id.toLowerCase()
}

export function requireUuid(value: unknown, label: string) {
	const id = String(value ?? '')
	if (!UUID.test(id)) throw new WorldError(`${label} must be an id returned by Kody World Builder.`)
	return id.toLowerCase()
}

const SLUG = /^[a-z0-9]{4,24}$/
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ADJECTIVES = ['Sunny', 'Misty', 'Golden', 'Hidden', 'Floating', 'Mossy', 'Crystal', 'Windy', 'Cozy', 'Glowing', 'Ancient', 'Snowy', 'Coral', 'Amber', 'Velvet', 'Starry']
const PLACES = ['Valley', 'Harbor', 'Meadow', 'Island', 'Canyon', 'Grove', 'Summit', 'Lagoon', 'Plateau', 'Village', 'Cove', 'Ridge', 'Garden', 'Orchard', 'Fjord', 'Dunes']

/** 10 characters from a 31-letter alphabet: ~49 bits, unguessable enough for share links. */
export function newRoomSlug() {
	const bytes = crypto.getRandomValues(new Uint8Array(10))
	return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('')
}

export function newRoomName() {
	const [a, b] = crypto.getRandomValues(new Uint8Array(2))
	return `${ADJECTIVES[a! % ADJECTIVES.length]} ${PLACES[b! % PLACES.length]}`
}

/** Room slug from a slug or a full room URL (".../r/<slug>"). */
export function parseRoomRef(value: unknown) {
	const raw = String(value ?? '').trim()
	const m = /\/r\/([a-z0-9]+)/i.exec(raw)
	const slug = (m ? m[1]! : raw).toLowerCase()
	return SLUG.test(slug) ? slug : null
}

export type Room = { id: string; slug: string; name: string; ownerId: string }

function toRoom(r: Record<string, unknown>): Room {
	return { id: String(r.id), slug: String(r.slug ?? ''), name: String(r.name), ownerId: String(r.created_by) }
}

export async function getRoom(slug: string) {
	const rows = await sql('select id, slug, name, created_by from worlds where slug = $1', [slug])
	if (!rows[0]) throw new WorldError('That room does not exist. Check the room link.', 404)
	const room = toRoom(rows[0])
	roomIds.set(slug, room.id)
	return room
}

/** Room slug -> world id never changes, so cache it per isolate (bounded). */
const roomIds = new Map<string, string>()
export async function roomIdForSlug(slug: string) {
	const hit = roomIds.get(slug)
	if (hit) return hit
	if (roomIds.size > 5000) roomIds.clear()
	return (await getRoom(slug)).id
}

export async function createRoom(ownerId: string) {
	await rateLimit(`rooms:${ownerId}`, 1, 10)
	for (let attempt = 0; attempt < 3; attempt++) {
		const rows = await sql(
			`insert into worlds (id, name, created_by, slug) values (gen_random_uuid(), $1, $2, $3)
			 on conflict (slug) do nothing returning id, slug, name, created_by`,
			[newRoomName(), ownerId, newRoomSlug()],
		)
		if (rows[0]) return toRoom(rows[0])
	}
	throw new WorldError('Could not create a room. Try again.', 503)
}

export async function renameRoom(slug: string, ownerId: string, name: unknown) {
	const clean = cleanText(name, LIMITS.maxNameLength)
	if (!clean) throw new WorldError('Give the room a name.')
	const room = await getRoom(slug)
	if (room.ownerId !== ownerId) throw new WorldError('Only the room owner can rename it.', 403)
	await rateLimit(`rename:${ownerId}`, 1, 30)
	const rows = await sql('update worlds set name = $2 where id = $1 returning id, slug, name, created_by', [room.id, clean])
	return toRoom(rows[0]!)
}

/** World id from `{ room }` (slug or room URL) or `{ worldId }`; defaults to the main world. */
export async function resolveWorld(input: { room?: unknown; worldId?: unknown } | undefined) {
	if (input?.room != null && input.room !== '') {
		const slug = parseRoomRef(input.room)
		if (!slug) throw new WorldError('room must be the room link (".../r/<code>") or its code.')
		return (await getRoom(slug)).id
	}
	return requireWorldId(input?.worldId)
}

export async function assertWorld(worldId: string) {
	const rows = await sql('select id, name from worlds where id = $1', [worldId])
	if (!rows[0]) throw new WorldError('That world does not exist.', 404)
	return { id: String(rows[0].id), name: String(rows[0].name) }
}

/** Fixed one-minute window counter in Postgres. Throws 429 past `limit`. */
export async function rateLimit(key: string, amount: number, limit: number) {
	const window = Math.floor(Date.now() / 60000)
	const rows = await sql(
		`insert into rate_limits (key, window_start, count) values ($1, $2, $3)
		 on conflict (key) do update set
		   count = case when rate_limits.window_start = $2 then rate_limits.count + $3 else $3 end,
		   window_start = $2
		 returning count`,
		[key, window, amount],
	)
	const count = num(rows[0]?.count)
	if (count > limit) {
		throw new WorldError(
			`Slow down: limit is ${limit} per minute. Try again in a few seconds.`,
			429,
		)
	}
}

export async function upsertPlayer(player: PlayerIdentity, worldId: string) {
	await sql(
		`insert into players (id, world_id, kind, owner_id, display_name, color, last_seen)
		 values ($1, $2, $3, $4, $5, $6, now())
		 on conflict (id) do update set world_id = excluded.world_id, display_name = excluded.display_name,
		   color = excluded.color, last_seen = now()`,
		[player.id, worldId, player.kind, player.ownerId, player.displayName, player.color],
	)
}

export type RateKey = { key: string; limit: number }

export type BlockOp =
	| { kind: 'put'; x: number; y: number; z: number; material: string }
	| { kind: 'del'; x: number; y: number; z: number }

export function parseBlockOp(raw: unknown, kind: 'put' | 'del'): BlockOp | null {
	if (!raw || typeof raw !== 'object') return null
	const r = raw as Record<string, unknown>
	const x = Number(r.x)
	const y = Number(r.y)
	const z = Number(r.z)
	if (!inBounds(x, y, z)) return null
	if (kind === 'del') return { kind, x, y, z }
	const material = String(r.material ?? '')
	if (!MATERIAL_KEYS.has(material)) return null
	return { kind, x, y, z, material }
}

/**
 * Validate, rate-limit, and apply block writes for one player in one world.
 * Last write wins per cell. Returns counts.
 */
export async function applyBlockOps(input: {
	player: PlayerIdentity
	worldId: string
	ops: Array<BlockOp>
	buildId?: string | null
	/** Extra per-minute counters (e.g. per IP) checked in the same transaction. */
	extraLimits?: Array<RateKey>
	/** Create the player row if missing (folded into the same transaction). */
	upsertPlayer?: boolean
}) {
	const { player, worldId } = input
	// Dedupe by cell: last op wins.
	const byCell = new Map<string, BlockOp>()
	for (const op of input.ops) byCell.set(blockId(worldId, op.x, op.y, op.z), op)
	const ops = [...byCell.entries()]
	if (ops.length === 0) return { placed: 0, removed: 0 }

	const limits: Array<RateKey> = [
		{
			key: `blocks:${player.id}`,
			limit: player.kind === 'agent' ? LIMITS.agentBlocksPerMinute : LIMITS.humanBlocksPerMinute,
		},
		// Also cap each owner across all of their agents, so new agent names can't multiply the limit.
		{ key: `owner-blocks:${player.ownerId}`, limit: LIMITS.ownerBlocksPerMinute },
		...(input.extraLimits ?? []),
	]
	const window = Math.floor(Date.now() / 60000)

	const puts = ops.filter(([, op]) => op.kind === 'put') as Array<
		[string, Extract<BlockOp, { kind: 'put' }>]
	>
	const dels = ops.filter(([, op]) => op.kind === 'del').map(([id]) => id)

	// One round trip: every rate-limit counter, the world-size check, and the
	// write run in a single Neon transaction. Writes only apply when the
	// counters (bumped earlier in this same transaction) are within limits.
	// New public-API agents need their player row before blocks reference it (FK).
	const pre: Array<Query> = input.upsertPlayer
		? [
				{
					query: `insert into players (id, world_id, kind, owner_id, display_name, color, last_seen)
					 values ($1, $2, $3, $4, $5, $6, now())
					 on conflict (id) do update set world_id = excluded.world_id, display_name = excluded.display_name,
					   color = excluded.color, last_seen = now()`,
					params: [player.id, worldId, player.kind, player.ownerId, player.displayName, player.color],
				},
			]
		: []
	const offset = pre.length
	const queries: Array<Query> = [...pre, ...limits.map(({ key }) => ({
		query: `insert into rate_limits (key, window_start, count) values ($1, $2, $3)
		 on conflict (key) do update set
		   count = case when rate_limits.window_start = $2 then rate_limits.count + $3 else $3 end,
		   window_start = $2
		 returning count`,
		params: [key, window, ops.length],
	}))]
	/** SQL guard "every counter within its limit", with params numbered from `start`. */
	const guard = (start: number) => ({
		sql: limits
			.map((_, i) => `(select count from rate_limits where key = $${start + i * 2}) <= $${start + i * 2 + 1}`)
			.join(' and '),
		params: limits.flatMap((l) => [l.key, l.limit]),
	})
	const room = LIMITS.maxBlocksPerWorld - puts.length
	const fullIndex = queries.length
	if (puts.length) {
		// "Full" = at least `room` blocks already exist (index scan that stops early; no count(*)).
		queries.push({
			query: `select exists (select 1 from blocks where world_id = $1::uuid offset greatest($2::int, 0) limit 1)::int as full`,
			params: [worldId, room],
		})
		const g = guard(10)
		queries.push({
			query: `insert into blocks (id, world_id, x, y, z, material, build_id, placed_by)
			  select t.id, $1::uuid, t.x, t.y, t.z, t.m, $2::uuid, $3
			  from unnest($4::text[], $5::int[], $6::int[], $7::int[], $8::text[]) as t(id, x, y, z, m)
			  where ${g.sql}
			    and not exists (select 1 from blocks where world_id = $1::uuid offset greatest($9::int, 0) limit 1)
			  on conflict (id) do update set material = excluded.material, build_id = excluded.build_id,
			    placed_by = excluded.placed_by, placed_at = now()`,
			params: [
				worldId,
				input.buildId ?? null,
				player.id,
				puts.map(([id]) => id),
				puts.map(([, o]) => o.x),
				puts.map(([, o]) => o.y),
				puts.map(([, o]) => o.z),
				puts.map(([, o]) => o.material),
				room,
				...g.params,
			],
		})
	}
	if (dels.length) {
		const g = guard(3)
		queries.push({
			query: `delete from blocks where world_id = $1 and id = any($2::text[]) and ${g.sql}`,
			params: [worldId, dels, ...g.params],
		})
	}
	if (input.buildId) {
		const g = guard(3)
		queries.push({
			query: `update builds set block_count = block_count + $2,
			  status = case when status = 'planning' then 'building' else status end
			  where id = $1 and ${g.sql}`,
			params: [input.buildId, puts.length, ...g.params],
		})
	}
	if (!input.upsertPlayer) {
		queries.push({ query: 'update players set last_seen = now(), world_id = $2 where id = $1', params: [player.id, worldId] })
	}
	const results = await transaction(queries)
	const over = limits.find((l, i) => num(results[offset + i]?.[0]?.count) > l.limit)
	if (over) {
		throw new WorldError(`Slow down: limit is ${over.limit} block changes per minute. Try again in a few seconds.`, 429)
	}
	if (puts.length && num(results[fullIndex]?.[0]?.full) === 1) {
		throw new WorldError('This world is full. Remove some blocks first.', 409)
	}
	return { placed: puts.length, removed: dels.length }
}

export async function updateCursor(
	player: PlayerIdentity,
	worldId: string,
	cursor: { x: number; y: number; z: number } | null,
) {
	const ok = cursor && inBounds(cursor.x, cursor.y, cursor.z)
	await sql(
		`update players set cursor_x = $2, cursor_y = $3, cursor_z = $4, last_seen = now(), world_id = $5 where id = $1`,
		[player.id, ok ? cursor!.x : null, ok ? cursor!.y : null, ok ? cursor!.z : null, worldId],
	)
}

/** The main world plus rooms `ownerId` created (rooms are private to their link). */
export async function listWorlds(ownerId: string) {
	const rows = await sql(
		`select w.id, w.slug, w.name, w.created_at,
		   (select count(*)::int from blocks b where b.world_id = w.id) as block_count,
		   (select count(*)::int from players p where p.world_id = w.id and p.last_seen > now() - interval '2 minutes') as active_players
		 from worlds w where w.slug = 'main' or w.created_by = $1 order by w.created_at desc limit 50`,
		[ownerId],
	)
	return rows.map((r) => ({
		id: String(r.id),
		room: r.slug == null ? null : String(r.slug),
		name: String(r.name),
		blockCount: num(r.block_count),
		activePlayers: num(r.active_players),
	}))
}

export async function createWorld(caller: PlayerIdentity, name: unknown) {
	const clean = cleanText(name, LIMITS.maxNameLength)
	if (!clean) throw new WorldError('Give the world a name.')
	await rateLimit(`worlds:${caller.ownerId}`, 1, 5)
	const rows = await sql(
		`insert into worlds (id, name, created_by, slug) values (gen_random_uuid(), $1, $2, $3) returning id, slug, name`,
		[clean, caller.ownerId, newRoomSlug()],
	)
	return { id: String(rows[0]!.id), room: String(rows[0]!.slug), name: String(rows[0]!.name) }
}

export async function describeWorld(
	worldId: string,
	region?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
) {
	const world = await assertWorld(worldId)
	const [stats, materials, heights, builds] = await Promise.all([
		sql(
			`select count(*)::int n, min(x) min_x, max(x) max_x, min(y) min_y, max(y) max_y, min(z) min_z, max(z) max_z
			 from blocks where world_id = $1`,
			[worldId],
		),
		sql(
			`select material, count(*)::int n from blocks where world_id = $1 group by material order by n desc`,
			[worldId],
		),
		sql(
			`select floor((x - $2) / 8.0)::int cx, floor((z - $3) / 8.0)::int cz, max(y)::int h
			 from blocks where world_id = $1 group by 1, 2`,
			[worldId, BOUNDS.minX, BOUNDS.minZ],
		),
		sql(
			`select b.id, b.prompt, b.status, b.block_count, p.display_name author
			 from builds b left join players p on p.id = b.author_id
			 where b.world_id = $1 order by b.created_at desc limit 10`,
			[worldId],
		),
	])
	const s = stats[0] ?? {}
	const cols = Math.ceil((BOUNDS.maxX - BOUNDS.minX + 1) / 8)
	const rowsN = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ + 1) / 8)
	const grid: Array<Array<number>> = Array.from({ length: rowsN }, () => Array(cols).fill(-1))
	for (const h of heights) {
		const cz = num(h.cz)
		const cx = num(h.cx)
		if (grid[cz] && cx >= 0 && cx < cols) grid[cz]![cx] = num(h.h)
	}
	let blocks: Array<{ x: number; y: number; z: number; material: string }> | undefined
	if (region) {
		const r = region
		const rows = await sql(
			`select x, y, z, material from blocks where world_id = $1
			 and x between $2 and $3 and y between $4 and $5 and z between $6 and $7
			 order by y, z, x limit 2000`,
			[worldId, r.minX, r.maxX, r.minY, r.maxY, r.minZ, r.maxZ],
		)
		blocks = rows.map((b) => ({ x: num(b.x), y: num(b.y), z: num(b.z), material: String(b.material) }))
	}
	return {
		world,
		rules: {
			bounds: BOUNDS,
			materials: [...MATERIAL_KEYS],
			yIsUp: true,
			groundLevel: 0,
			maxBlocksPerCall: LIMITS.maxAgentBlocksPerCall,
		},
		blockCount: num(s.n),
		occupiedBounds:
			num(s.n) > 0
				? {
						minX: num(s.min_x),
						maxX: num(s.max_x),
						minY: num(s.min_y),
						maxY: num(s.max_y),
						minZ: num(s.min_z),
						maxZ: num(s.max_z),
					}
				: null,
		materials: materials.map((m) => ({ material: String(m.material), count: num(m.n) })),
		heightMap: {
			cellSize: 8,
			origin: { x: BOUNDS.minX, z: BOUNDS.minZ },
			note: 'rows are z cells, columns are x cells; value is the tallest block y in that 8x8 cell, -1 when empty',
			cells: grid,
		},
		recentBuilds: builds.map((b) => ({
			id: String(b.id),
			prompt: b.prompt == null ? null : String(b.prompt),
			status: String(b.status),
			blockCount: num(b.block_count),
			author: b.author == null ? null : String(b.author),
		})),
		...(blocks ? { blocks } : {}),
	}
}

export async function startBuild(player: PlayerIdentity, worldId: string, prompt: unknown) {
	await assertWorld(worldId)
	await rateLimit(`builds:${player.id}`, 1, 20)
	await upsertPlayer(player, worldId)
	const rows = await sql(
		`insert into builds (id, world_id, author_id, prompt, status) values (gen_random_uuid(), $1, $2, $3, 'planning')
		 returning id`,
		[worldId, player.id, cleanText(prompt, LIMITS.maxPromptLength) || null],
	)
	return String(rows[0]!.id)
}

/** The build, checked to belong to an agent owned by `ownerId`. */
export async function ownedBuild(buildId: string, ownerId: string) {
	const rows = await sql(
		`select b.id, b.world_id, b.status, b.author_id, p.owner_id, p.kind, p.display_name, p.color
		 from builds b join players p on p.id = b.author_id where b.id = $1`,
		[buildId],
	)
	const row = rows[0]
	if (!row) throw new WorldError('That build does not exist.', 404)
	if (String(row.owner_id) !== ownerId) throw new WorldError('That build belongs to someone else.', 403)
	return {
		id: String(row.id),
		worldId: String(row.world_id),
		status: String(row.status),
		player: {
			id: String(row.author_id),
			kind: String(row.kind) as 'agent' | 'human',
			ownerId: String(row.owner_id),
			displayName: String(row.display_name),
			color: String(row.color),
		} satisfies PlayerIdentity,
	}
}

export async function finishBuild(buildId: string, status: 'done' | 'failed') {
	await sql(`update builds set status = $2 where id = $1`, [buildId, status])
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A build and its author, for the public API (holding the build id is the permission). */
export async function getBuild(buildId: string) {
	const rows = await sql(
		`select b.id, b.world_id, b.status, b.author_id, p.owner_id, p.kind, p.display_name, p.color
		 from builds b join players p on p.id = b.author_id where b.id = $1`,
		[buildId],
	)
	const row = rows[0]
	if (!row) throw new WorldError('That build does not exist.', 404)
	return {
		id: String(row.id),
		worldId: String(row.world_id),
		status: String(row.status),
		player: {
			id: String(row.author_id),
			kind: String(row.kind) as 'agent' | 'human',
			ownerId: String(row.owner_id),
			displayName: String(row.display_name),
			color: String(row.color),
		} satisfies PlayerIdentity,
	}
}

/** Exact blocks inside a box (at most `limit`). */
export async function regionBlocks(
	worldId: string,
	r: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
	limit = 5000,
) {
	const rows = await sql(
		`select x, y, z, material from blocks where world_id = $1
		 and x between $2 and $3 and y between $4 and $5 and z between $6 and $7
		 order by y, z, x limit $8`,
		[worldId, r.minX, r.maxX, r.minY, r.maxY, r.minZ, r.maxZ, limit],
	)
	return rows.map((b) => ({ x: num(b.x), y: num(b.y), z: num(b.z), material: String(b.material) }))
}
