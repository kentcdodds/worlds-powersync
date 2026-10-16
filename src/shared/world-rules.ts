/**
 * Rules shared by the browser client, the app Worker, and agent exports.
 * Keep this file free of `kody:` and DOM imports.
 */

export const DEFAULT_WORLD_ID = '00000000-0000-4000-8000-000000000001'

/** Inclusive coordinate bounds for every world. */
export const BOUNDS = {
	minX: -48,
	maxX: 47,
	minY: 0,
	maxY: 47,
	minZ: -48,
	maxZ: 47,
} as const

export type MaterialKey =
	| 'grass'
	| 'dirt'
	| 'stone'
	| 'cobble'
	| 'brick'
	| 'wood'
	| 'plank'
	| 'leaves'
	| 'sand'
	| 'water'
	| 'glass'
	| 'snow'
	| 'gold'
	| 'lava'
	| 'obsidian'
	| 'banner'

export const MATERIALS: ReadonlyArray<{
	key: MaterialKey
	label: string
	color: string
	opacity?: number
	emissive?: string
}> = [
	{ key: 'grass', label: 'Grass', color: '#5fa04e' },
	{ key: 'dirt', label: 'Dirt', color: '#8a5a3b' },
	{ key: 'stone', label: 'Stone', color: '#8d9399' },
	{ key: 'cobble', label: 'Cobblestone', color: '#6b7075' },
	{ key: 'brick', label: 'Brick', color: '#b0503c' },
	{ key: 'wood', label: 'Log', color: '#6e4b2a' },
	{ key: 'plank', label: 'Planks', color: '#c49a5b' },
	{ key: 'leaves', label: 'Leaves', color: '#2f7d32' },
	{ key: 'sand', label: 'Sand', color: '#e2d29b' },
	{ key: 'water', label: 'Water', color: '#3d7fd9', opacity: 0.7 },
	{ key: 'glass', label: 'Glass', color: '#bfe6f5', opacity: 0.35 },
	{ key: 'snow', label: 'Snow', color: '#f4f7fa' },
	{ key: 'gold', label: 'Gold', color: '#f2c230', emissive: '#4a3500' },
	{ key: 'lava', label: 'Lava', color: '#ff6a1a', emissive: '#b33000' },
	{ key: 'obsidian', label: 'Obsidian', color: '#2a2338' },
	{ key: 'banner', label: 'Banner', color: '#c2185b' },
]

export const MATERIAL_KEYS: ReadonlySet<string> = new Set(
	MATERIALS.map((m) => m.key),
)

/** Write limits. The app enforces these server-side for humans and agents. */
export const LIMITS = {
	/** Max operations in one browser upload batch. */
	maxUploadOps: 200,
	/** Max blocks in one agent placeBlocks / removeBlocks call. */
	maxAgentBlocksPerCall: 600,
	/** Block writes per rolling minute, per human player. */
	humanBlocksPerMinute: 900,
	/** Block writes per rolling minute, per agent player. */
	agentBlocksPerMinute: 2400,
	/** Block writes per minute across all of one owner's players (person, guest, or agent IP). */
	ownerBlocksPerMinute: 3000,
	/** Block writes per minute from one IP address (guests and public API agents). */
	ipBlocksPerMinute: 3000,
	/** Rooms one IP address can create per minute. */
	ipRoomsPerMinute: 5,
	/** Max block changes in one public API call. */
	maxApiOpsPerCall: 600,
	/** Cursor updates per minute, per player. */
	cursorUpdatesPerMinute: 400,
	/** Hard cap on blocks stored in a single world. */
	maxBlocksPerWorld: 60000,
	/** Max active builds per agent player at once. */
	maxPromptLength: 280,
	maxNameLength: 40,
} as const

export function blockId(worldId: string, x: number, y: number, z: number) {
	return `${worldId}:${x}:${y}:${z}`
}

export function inBounds(x: number, y: number, z: number) {
	return (
		Number.isInteger(x) &&
		Number.isInteger(y) &&
		Number.isInteger(z) &&
		x >= BOUNDS.minX &&
		x <= BOUNDS.maxX &&
		y >= BOUNDS.minY &&
		y <= BOUNDS.maxY &&
		z >= BOUNDS.minZ &&
		z <= BOUNDS.maxZ
	)
}

const PLAYER_COLORS = [
	'#e53935',
	'#8e24aa',
	'#3949ab',
	'#039be5',
	'#00897b',
	'#7cb342',
	'#fdd835',
	'#fb8c00',
	'#6d4c41',
	'#d81b60',
	'#5e35b1',
	'#00acc1',
]

/** Stable color for a player id. */
export function colorFor(id: string) {
	let hash = 0
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
	return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length]!
}

/** Lowercase slug, letters/digits/dashes only, for agent player ids. */
export function slugify(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 24) || 'agent'
	)
}

/** Strip control characters and trim to a max length. */
export function cleanText(value: unknown, max: number) {
	if (typeof value !== 'string') return ''
	return value
		.replace(/[\u0000-\u001f\u007f<>]/g, '')
		.trim()
		.slice(0, max)
}
