import { credential } from './platform.ts'
import { cleanText, colorFor, slugify } from '../shared/world-rules.ts'
import { JWKS } from './jwks.ts'
import { JWT_KID, POWERSYNC_HOST, POWERSYNC_URL } from './config.ts'
import type { PlayerIdentity } from './identity.ts'

/**
 * Guest identities for people who build without signing in. The server signs a
 * small RS256 token with the existing `powersync-jwt` signing credential
 * (`wb: 'guest'` claim) and verifies it with the public key in `jwks.ts`, so no
 * extra secret is needed. The browser keeps it in localStorage and sends it as
 * the `x-wb-guest` header.
 */

const GUEST_TTL_SECONDS = 90 * 24 * 60 * 60
const ADJ = ['Brave', 'Sunny', 'Clever', 'Mossy', 'Swift', 'Cozy', 'Lucky', 'Jolly', 'Misty', 'Bold', 'Quiet', 'Zippy']
const ANIMALS = ['Fox', 'Otter', 'Panda', 'Koala', 'Falcon', 'Badger', 'Lynx', 'Heron', 'Gecko', 'Moose', 'Wombat', 'Yak']

export type Guest = { id: string; name: string }

export function guestPlayer(guest: Guest): PlayerIdentity {
	return { id: guest.id, kind: 'human', ownerId: guest.id, displayName: guest.name, color: colorFor(guest.id) }
}

/** Mint a guest token. Pass `name` (visitor-chosen) and `id` (to keep an existing guest's identity on rename). */
export async function issueGuest(opts: { name?: unknown; id?: string } = {}): Promise<{ guest: Guest; token: string }> {
	const [a, b, c] = crypto.getRandomValues(new Uint8Array(3))
	const guest = {
		id: opts.id && /^g:[0-9a-f-]{36}$/i.test(opts.id) ? opts.id : `g:${crypto.randomUUID()}`,
		name: cleanText(opts.name, 40) || `${ADJ[a! % ADJ.length]} ${ANIMALS[b! % ANIMALS.length]} ${10 + (c! % 90)}`,
	}
	const signer = await credential('powersync-jwt')
	const iat = Math.floor(Date.now() / 1000)
	const result = (await signer.sign({
		type: 'jwt',
		algorithm: 'RS256',
		host: POWERSYNC_HOST,
		header: { kid: JWT_KID, typ: 'JWT' },
		claims: { sub: guest.id, aud: POWERSYNC_URL, iat, exp: iat + GUEST_TTL_SECONDS, wb: 'guest', name: guest.name },
	} as never)) as unknown
	const token =
		typeof result === 'string'
			? result
			: String((result as { signature?: string; jwt?: string }).signature ?? (result as { jwt?: string }).jwt)
	return { guest, token }
}

const b64urlBytes = (s: string) => {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

let keyPromise: Promise<CryptoKey> | null = null
function publicKey() {
	keyPromise ??= crypto.subtle.importKey(
		'jwk',
		{ ...JWKS.keys[0], ext: true } as JsonWebKey,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	)
	return keyPromise
}

/** The guest behind a token from `issueGuest`, or null if missing, forged, or expired. */
export async function verifyGuest(token: string | null | undefined): Promise<Guest | null> {
	if (!token || token.length > 4096) return null
	const parts = token.split('.')
	if (parts.length !== 3) return null
	try {
		const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0]!))) as { alg?: string; kid?: string }
		if (header.alg !== 'RS256' || header.kid !== JWT_KID) return null
		const ok = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			await publicKey(),
			b64urlBytes(parts[2]!),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		)
		if (!ok) return null
		const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1]!))) as Record<string, unknown>
		if (claims.wb !== 'guest' || claims.aud !== POWERSYNC_URL) return null
		if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
		const id = String(claims.sub ?? '')
		if (!/^g:[0-9a-f-]{36}$/i.test(id)) return null
		return { id, name: cleanText(claims.name, 40) || 'Guest' }
	} catch {
		return null
	}
}

/** Hashed client IP (never stored raw) for per-IP limits and anonymous agent ids. */
export async function ipHash(request: Request) {
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-real-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		'unknown'
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`world-builder:${ip}`))
	return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A public-API agent: identified by its label plus a hash of its IP address. */
export function apiAgentPlayer(label: unknown, ip: string): PlayerIdentity {
	const name = cleanText(label, 32) || 'Agent'
	const id = `a:ip-${ip.slice(0, 10)}:${slugify(name)}`
	return { id, kind: 'agent', ownerId: `ip:${ip}`, displayName: name, color: colorFor(id) }
}
