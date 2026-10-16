import { inBounds, type MaterialKey } from './world-rules.ts'

export type PlannedBlock = { x: number; y: number; z: number; material: MaterialKey }

/**
 * A small castle: courtyard floor, crenellated walls, four towers with roofs,
 * a gate, and a banner. Ordered bottom-up so it rises as it streams.
 */
export function planCastle(cx: number, cz: number, half = 7): Array<PlannedBlock> {
	const out = new Map<string, PlannedBlock>()
	const put = (x: number, y: number, z: number, material: MaterialKey) => {
		if (inBounds(x, y, z)) out.set(`${x}:${y}:${z}`, { x, y, z, material })
	}
	const wallH = 5
	// Floor
	for (let x = -half; x <= half; x++)
		for (let z = -half; z <= half; z++) put(cx + x, 0, cz + z, (x + z) % 2 === 0 ? 'cobble' : 'stone')
	// Walls
	for (let y = 1; y <= wallH; y++)
		for (let i = -half; i <= half; i++) {
			for (const [x, z] of [
				[i, -half],
				[i, half],
				[-half, i],
				[half, i],
			] as const) {
				const isGate = z === half && Math.abs(x) <= 1 && y <= 3
				if (!isGate) put(cx + x, y, cz + z, 'stone')
			}
		}
	// Crenellations
	for (let i = -half; i <= half; i += 2)
		for (const [x, z] of [
			[i, -half],
			[i, half],
			[-half, i],
			[half, i],
		] as const)
			put(cx + x, wallH + 1, cz + z, 'cobble')
	// Towers
	for (const [tx, tz] of [
		[-half, -half],
		[half, -half],
		[-half, half],
		[half, half],
	] as const) {
		const towerH = wallH + 4
		for (let y = 1; y <= towerH; y++)
			for (let dx = -1; dx <= 1; dx++)
				for (let dz = -1; dz <= 1; dz++)
					if (dx !== 0 || dz !== 0 || y === towerH) put(cx + tx + dx, y, cz + tz + dz, 'brick')
		for (let dx = -2; dx <= 2; dx++)
			for (let dz = -2; dz <= 2; dz++)
				if (Math.abs(dx) === 2 || Math.abs(dz) === 2) put(cx + tx + dx, towerH + 1, cz + tz + dz, 'obsidian')
		put(cx + tx, towerH + 1, cz + tz, 'gold')
	}
	// Keep
	for (let y = 1; y <= 7; y++)
		for (let dx = -2; dx <= 2; dx++)
			for (let dz = -2; dz <= 2; dz++)
				if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
					const window = y === 4 && (dx === 0 || dz === 0)
					put(cx + dx, y, cz + dz, window ? 'glass' : 'plank')
				}
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) put(cx + dx, 8, cz + dz, 'wood')
	// Flagpole + banner
	for (let y = 9; y <= 12; y++) put(cx, y, cz, 'wood')
	put(cx + 1, 12, cz, 'banner')
	put(cx + 2, 12, cz, 'banner')
	put(cx + 1, 11, cz, 'banner')
	return [...out.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
}
