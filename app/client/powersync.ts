import {
	PowerSyncDatabase,
	Schema,
	Table,
	column,
	type AbstractPowerSyncDatabase,
	type PowerSyncBackendConnector,
} from '@powersync/web'
import { apiFetch } from './nav.ts'

const worlds = new Table({ name: column.text, slug: column.text, created_by: column.text, created_at: column.text })
const players = new Table(
	{
		world_id: column.text,
		kind: column.text,
		owner_id: column.text,
		display_name: column.text,
		color: column.text,
		cursor_x: column.integer,
		cursor_y: column.integer,
		cursor_z: column.integer,
		last_seen: column.text,
	},
	{ indexes: { world: ['world_id'] } },
)
const builds = new Table(
	{
		world_id: column.text,
		author_id: column.text,
		prompt: column.text,
		status: column.text,
		block_count: column.integer,
		created_at: column.text,
	},
	{ indexes: { world: ['world_id'] } },
)
const blocks = new Table(
	{
		world_id: column.text,
		x: column.integer,
		y: column.integer,
		z: column.integer,
		material: column.text,
		build_id: column.text,
		placed_by: column.text,
		placed_at: column.text,
		seq: column.integer,
	},
	{ indexes: { world: ['world_id'] } },
)

export const schema = new Schema({ worlds, players, builds, blocks })

export type BlockRow = {
	id: string
	world_id: string
	x: number
	y: number
	z: number
	material: string
	build_id: string | null
	placed_by: string | null
	seq: number | null
}
export type PlayerRow = {
	id: string
	world_id: string
	kind: 'human' | 'agent'
	owner_id: string
	display_name: string
	color: string
	cursor_x: number | null
	cursor_y: number | null
	cursor_z: number | null
	last_seen: string | null
}
export type BuildRow = {
	id: string
	world_id: string
	author_id: string
	prompt: string | null
	status: string
	block_count: number
	created_at: string
}

class UploadRetry extends Error {}

export function createConnector(appBase: string): PowerSyncBackendConnector {
	return {
		async fetchCredentials() {
			const response = await apiFetch(`${appBase}/api/token`)
			if (!response.ok) throw new Error(`token ${response.status}`)
			const body = (await response.json()) as { endpoint: string; token: string; expiresAt: string }
			return { endpoint: body.endpoint, token: body.token, expiresAt: new Date(body.expiresAt) }
		},
		async uploadData(database: AbstractPowerSyncDatabase) {
			const batch = await database.getCrudBatch(150)
			if (!batch) return
			const ops = batch.crud.map((entry) => ({
				op: entry.op,
				type: entry.table,
				id: entry.id,
				data: entry.opData ?? {},
			}))
			const response = await apiFetch(`${appBase}/api/upload`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ops }),
			})
			if (response.status === 429 || response.status >= 500 || response.status === 401) {
				throw new UploadRetry(`upload ${response.status}`)
			}
			// 2xx and other 4xx: the server applied what it accepted; rejected
			// writes are reverted locally by the next sync checkpoint.
			await batch.complete()
		},
	}
}

export function openDatabase(assetBase: string) {
	const worker = `${assetBase}/powersync/worker.js`
	return new PowerSyncDatabase({
		schema,
		database: { dbFilename: 'kody-world-builder.sqlite', worker },
		sync: { worker },
	})
}
