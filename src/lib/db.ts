import { credential } from './platform.ts'
import { NEON_SQL_URL } from './config.ts'
import { timed } from './timing.ts'

/**
 * Minimal Neon serverless-HTTP client. The `neon-postgres` credential injects the
 * Postgres connection string as the `Neon-Connection-String` header, only to
 * the approved Neon endpoint host. Code never sees the value.
 */

export type Row = Record<string, unknown>
export type Query = { query: string; params?: Array<unknown> }

type Db = Awaited<ReturnType<typeof credential>>
/**
 * The credential handle is cached per isolate: it is an opaque fetch proxy (the
 * connection string is injected by the platform and never visible here), and
 * every visitor uses the same owner credential. On any failure the cache is
 * dropped and the next call resolves it again.
 */
let cached: Promise<Db> | null = null
function db() {
	cached ??= timed('cred', () => credential('neon-postgres')).catch((error) => {
		cached = null
		throw error
	})
	return cached
}

async function post(body: unknown, batch: boolean) {
	try {
		return await postWith(await db(), body, batch)
	} catch (error) {
		// A stale cached handle: resolve the credential again and retry once.
		// Database errors (bad SQL, constraint) are not retried.
		if (error instanceof DbError) throw error
		cached = null
		return postWith(await db(), body, batch)
	}
}

class DbError extends Error {}

async function postWith(db: Db, body: unknown, batch: boolean) {
	const response: Response = await timed("neon", () => (db as { fetch: typeof fetch }).fetch(NEON_SQL_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'Neon-Array-Mode': 'false',
			'Neon-Raw-Text-Output': 'true',
			...(batch ? { 'Neon-Batch-Isolation-Level': 'ReadCommitted' } : {}),
		},
		body: JSON.stringify(body),
	}))
	const text = await response.text()
	if (!response.ok) {
		let message = text.slice(0, 300)
		try {
			message = (JSON.parse(text) as { message?: string }).message ?? message
		} catch {}
		throw new DbError(`Database error (${response.status}): ${message}`)
	}
	return JSON.parse(text) as unknown
}

export async function sql(query: string, params: Array<unknown> = []) {
	const out = (await post({ query, params }, false)) as { rows: Array<Row> }
	return out.rows
}

/** Run queries in one transaction; returns rows per query. */
export async function transaction(queries: Array<Query>) {
	if (queries.length === 0) return []
	const out = (await post(
		{ queries: queries.map((q) => ({ query: q.query, params: q.params ?? [] })) },
		true,
	)) as { results: Array<{ rows: Array<Row> }> }
	return out.results.map((r) => r.rows)
}

export const num = (value: unknown) => (value == null ? 0 : Number(value))
