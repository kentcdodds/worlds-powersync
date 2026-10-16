/** PowerSync Cloud instance that serves this fork's sync stream (instance `cloudflare-fork`). */
export const POWERSYNC_URL = 'https://6ad296de3b1803753bd2489f.powersync.journeyapps.com'
export const POWERSYNC_HOST = new URL(POWERSYNC_URL).host
/** Key id of the RS256 signing key (matches `src/lib/jwks.ts`). */
export const JWT_KID = 'wbcf-kvyZnGEyy6'
/** Client token lifetime. Short on purpose; the SDK refetches before expiry. */
export const TOKEN_TTL_SECONDS = 5 * 60
/** Unused on Workers: the Neon /sql host is derived from the DATABASE_URL secret. */
export const NEON_SQL_URL = ''
