import { credential } from './platform.ts'
import { JWT_KID, POWERSYNC_HOST, POWERSYNC_URL, TOKEN_TTL_SECONDS } from './config.ts'

/** Sign a short-lived RS256 PowerSync client token for `subject`. */
export async function signPowerSyncToken(subject: string) {
	const signer = await credential('powersync-jwt')
	const iat = Math.floor(Date.now() / 1000)
	const exp = iat + TOKEN_TTL_SECONDS
	const result = (await signer.sign({
		type: 'jwt',
		algorithm: 'RS256',
		host: POWERSYNC_HOST,
		header: { kid: JWT_KID, typ: 'JWT' },
		claims: { sub: subject, aud: POWERSYNC_URL, iat, exp },
	} as never)) as unknown
	const token =
		typeof result === 'string'
			? result
			: String((result as { signature?: string; jwt?: string }).signature ?? (result as { jwt?: string }).jwt)
	return { token, endpoint: POWERSYNC_URL, expiresAt: new Date(exp * 1000).toISOString() }
}
