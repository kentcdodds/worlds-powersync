import { PowerSyncContext } from '@powersync/react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, type Room, type Session } from './App.tsx'
import { Landing } from './Landing.tsx'
import { apiFetch, chooseName, clearGuestToken, hasChosenName, navigate, saveGuestToken } from './nav.ts'
import { createConnector, openDatabase } from './powersync.ts'

const appBase = document.documentElement.dataset.appBase ?? ''
const assetBase = document.documentElement.dataset.assetBase ?? `${appBase}/_assets`
const db = openDatabase(assetBase)

function routeFromLocation() {
	let path = location.pathname
	if (appBase && path.startsWith(appBase)) path = path.slice(appBase.length)
	const m = /^\/r\/([a-z0-9]{4,24})\/?$/i.exec(path)
	return m ? { room: m[1]!.toLowerCase() } : { room: null }
}


async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
	const res = await apiFetch(url, init)
	return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as T }
}

type RoomState =
	| { kind: 'loading' }
	| { kind: 'missing'; message: string; status: number }
	| { kind: 'ready'; room: Room; session: Session }

function RoomRoute({ slug }: { slug: string }) {
	const [state, setState] = useState<RoomState>({ kind: 'loading' })
	useEffect(() => {
		let cancelled = false
		void (async () => {
			const r = await getJson<{ room?: Room; error?: string }>(`${appBase}/api/rooms/${slug}`)
			if (!r.ok || !r.body.room) {
				if (!cancelled) setState({ kind: 'missing', status: r.status, message: r.body.error ?? 'That room does not exist.' })
				return
			}
			const room = r.body.room
			// No accounts: first visit asks for a display name (cancel = a random guest name).
			if (!hasChosenName()) await chooseName('')
			const s = await getJson<Session & { guestToken?: string }>(`${appBase}/api/session?world=${room.worldId}`)
			if (s.ok && s.body.signedIn) clearGuestToken()
			else if (s.ok) saveGuestToken(s.body.guestToken)
			if (cancelled) return
			const session = s.ok ? s.body : { signedIn: false, worldId: room.worldId, powersyncUrl: 'https://powersync.invalid' }
			await db.disconnect()
			void db.connect(createConnector(appBase), {
				params: { world_id: room.worldId },
				// Upload local edits almost immediately; recover quickly from a failed upload.
				crudUploadThrottleMs: 100,
				retryDelayMs: 1500,
			})
			;(window as unknown as { __wb: unknown }).__wb = { db, session, room }
			setState({ kind: 'ready', room, session })
		})()
		return () => {
			cancelled = true
		}
	}, [slug])
	if (state.kind === 'loading') {
		return (
			<div className="boot">
				<div className="boot-cube" />
			</div>
		)
	}
	if (state.kind === 'missing') {
		return (
			<div className="missing">
				<h1>{state.status === 404 ? 'Room not found' : 'This room could not load'}</h1>
				<p>{state.message}</p>
				<button type="button" className="cta" onClick={() => navigate('/')}>
					Go to the start page
				</button>
			</div>
		)
	}
	return <App key={state.room.worldId} session={state.session} initialRoom={state.room} />
}

function Root() {
	const [route, setRoute] = useState(routeFromLocation)
	useEffect(() => {
		const on = () => setRoute(routeFromLocation())
		addEventListener('popstate', on)
		return () => removeEventListener('popstate', on)
	}, [])
	useEffect(() => {
		if (!route.room) void db.disconnect()
	}, [route.room])
	return route.room ? <RoomRoute slug={route.room} /> : <Landing appBase={appBase} />
}

createRoot(document.getElementById('root')!).render(
	<PowerSyncContext.Provider value={db}>
		<Root />
	</PowerSyncContext.Provider>,
)
