const appBase = document.documentElement.dataset.appBase ?? ''

export function navigate(path: string) {
	history.pushState(null, '', `${appBase}${path}`)
	dispatchEvent(new PopStateEvent('popstate'))
}

const NAME_SET_KEY = 'wb-name-set'

/** Has this browser picked a name yet? */
export function hasChosenName() {
	try {
		return localStorage.getItem(NAME_SET_KEY) === '1'
	} catch {
		return false
	}
}

/** Ask for a name (no accounts) and get a guest token for it. Returns the saved name, or null if cancelled. */
export async function chooseName(current?: string | null) {
	const name = window.prompt('What name should other builders see?', current ?? '')?.trim()
	if (!name) return null
	const res = await apiFetch(`${appBase}/api/name`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name }),
	})
	const body = (await res.json().catch(() => ({}))) as { guestToken?: string; displayName?: string; error?: string }
	if (!res.ok || !body.guestToken) {
		window.alert(body.error ?? 'Could not save that name. Try again.')
		return null
	}
	saveGuestToken(body.guestToken)
	try {
		localStorage.setItem(NAME_SET_KEY, '1')
	} catch {}
	return body.displayName ?? name
}

const GUEST_KEY = 'wb-guest-token'

/** Signed guest token for building without an account (kept in localStorage). */
export function guestToken() {
	try {
		return localStorage.getItem(GUEST_KEY)
	} catch {
		return null
	}
}

export function clearGuestToken() {
	try {
		localStorage.removeItem(GUEST_KEY)
	} catch {}
}

export function saveGuestToken(token: unknown) {
	if (typeof token !== 'string' || !token) return
	try {
		localStorage.setItem(GUEST_KEY, token)
	} catch {}
}

/** fetch() for this app's API: same-origin cookies plus the guest token header. */
export function apiFetch(url: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers)
	const t = guestToken()
	if (t) headers.set('x-wb-guest', t)
	return fetch(url, { credentials: 'same-origin', ...init, headers })
}
