/**
 * Cloudflare Workers platform glue (replaces the Kody runtime).
 * Secrets come from Worker secrets and never leave the Worker:
 * - DATABASE_URL: Neon Postgres connection string (sent as the
 *   `Neon-Connection-String` header to Neon's HTTPS /sql endpoint).
 * - POWERSYNC_PRIVATE_KEY: RS256 PKCS#8 PEM that signs PowerSync + guest tokens.
 */
import { env } from 'cloudflare:workers'

type Env = { DATABASE_URL?: string; POWERSYNC_PRIVATE_KEY?: string }
const E = env as unknown as Env

/** No path prefix: the app owns the whole origin; static assets are at the root. */
export const packageContext = { appBasePath: '', assetBasePath: '' }

/** There is no sign-in in this build: everyone is a named guest. */
export const kody = {
	async metaGetCurrentUser(_: unknown): Promise<{ username?: string; displayName?: string }> {
		return {}
	},
}

const b64url = (bytes: Uint8Array) => {
	let s = ''
	for (const b of bytes) s += String.fromCharCode(b)
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))

let signingKey: Promise<CryptoKey> | null = null
function privateKey() {
	signingKey ??= (async () => {
		const pem = String(E.POWERSYNC_PRIVATE_KEY ?? '')
		if (!pem) throw new Error('POWERSYNC_PRIVATE_KEY is not set')
		const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
		return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
	})().catch((e) => {
		signingKey = null
		throw e
	})
	return signingKey
}

async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>) {
	const input = `${enc({ alg: 'RS256', ...header })}.${enc(claims)}`
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await privateKey(), new TextEncoder().encode(input))
	return `${input}.${b64url(new Uint8Array(sig))}`
}

function neonSqlUrl() {
	const url = String(E.DATABASE_URL ?? '')
	if (!url) throw new Error('DATABASE_URL is not set')
	return `https://${new URL(url).hostname}/sql`
}

/** Same shape as the Kody credential handles the app code was written against. */
type Handle = {
	fetch: (url: string, init?: RequestInit) => Promise<Response>
	sign: (opts: { header?: Record<string, unknown>; claims: Record<string, unknown> }) => Promise<string>
}
export async function credential(name: string): Promise<Handle> {
	if (name === 'neon-postgres') {
		return {
			sign: () => Promise.reject(new Error('not a signing credential')),
			fetch(_url: string, init: RequestInit = {}) {
				const headers = new Headers(init.headers)
				headers.set('Neon-Connection-String', String(E.DATABASE_URL))
				return fetch(neonSqlUrl(), { ...init, headers })
			},
		}
	}
	return {
		fetch: () => Promise.reject(new Error('not a fetch credential')),
		async sign(opts: { header?: Record<string, unknown>; claims: Record<string, unknown> }) {
			return signJwt(opts.header ?? {}, opts.claims)
		},
	}
}
