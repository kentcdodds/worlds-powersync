import { useEffect, useMemo, useState } from 'react'
import { planCastle } from '../../src/shared/castle.ts'
import { BotIcon, PersonIcon, SyncIcon } from './icons.tsx'
import { apiFetch, chooseName, clearGuestToken, hasChosenName, navigate, saveGuestToken } from './nav.ts'
import type { BlockRow, BuildRow, PlayerRow } from './powersync.ts'
import { World } from './World.tsx'

const PREVIEW_WORLD = 'preview'
const noop = () => {}

/** A castle that builds itself in a loop: a local stand-in for an agent build streaming in. */
function usePreviewBlocks() {
	const plan = useMemo(() => planCastle(0, 0), [])
	const [count, setCount] = useState(0)
	useEffect(() => {
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		if (reduce) {
			setCount(plan.length)
			return
		}
		const t = setInterval(() => setCount((c) => (c >= plan.length + 60 ? 0 : c + 12)), 120)
		return () => clearInterval(t)
	}, [plan])
	return useMemo<Array<BlockRow>>(
		() =>
			plan.slice(0, Math.min(count, plan.length)).map((b) => ({
				id: `${b.x}:${b.y}:${b.z}`,
				world_id: PREVIEW_WORLD,
				x: b.x,
				y: b.y,
				z: b.z,
				material: b.material,
				build_id: null,
				placed_by: null,
				seq: null,
			})),
		[plan, count],
	)
}

export function Landing({ appBase }: { appBase: string }) {
	const blocks = usePreviewBlocks()
	const [me, setMe] = useState<{ signedIn: boolean; displayName?: string } | null>(null)
	const [creating, setCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		void apiFetch(`${appBase}/api/me`)
			.then((r) => r.json())
			.then(
				(body: { signedIn: boolean; displayName?: string; guestToken?: string }) => {
					if (body.signedIn) clearGuestToken()
					else saveGuestToken(body.guestToken)
					setMe(body)
				},
				() => setMe({ signedIn: false }),
			)
	}, [appBase])

	async function rename() {
		const name = await chooseName(me?.displayName)
		if (name) setMe({ signedIn: false, displayName: name })
		return name
	}
	async function ensureName() {
		return hasChosenName() || !!(await rename())
	}

	async function createRoom() {
		if (!(await ensureName())) return
		setCreating(true)
		setError(null)
		try {
			const res = await apiFetch(`${appBase}/api/rooms`, { method: 'POST' })
			const body = (await res.json().catch(() => ({}))) as { room?: { slug: string }; error?: string }
			if (!res.ok || !body.room) throw new Error(body.error ?? 'Could not create a room. Try again.')
			navigate(`/r/${body.room.slug}`)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not create a room. Try again.')
			setCreating(false)
		}
	}

	const signedOut = me !== null && !me.signedIn
	return (
		<div className="landing">
			<div className="landing-preview" aria-hidden="true">
				<World
					blocks={blocks}
					players={[] as Array<PlayerRow>}
					builds={[] as Array<BuildRow>}
					meId={null}
					mode="place"
					canEdit={false}
					onPlace={noop}
					onRemove={noop}
					onHover={noop}
				/>
			</div>
			<header className="landing-top">
				<div className="brand">
					<img src={`${document.documentElement.dataset.assetBase}/icon.png`} alt="" width={30} height={30} />
					<strong>World Builder</strong>
				</div>
				{me ? (
					<button type="button" className="chip" onClick={rename} title="Change the name other builders see">
						{me.displayName ?? 'Pick a name'} ✎
					</button>
				) : null}
			</header>
			<main className="hero">
				<p className="eyebrow">
					<span className="live-dot" /> Live multiplayer · humans + agents
				</p>
				<h1>Build a 3D world together, with your friends and your AI agents.</h1>
				<p className="lede">
					Open a room, share the link, and place blocks together. Then paste one prompt into Claude, ChatGPT or Grok and
					ask for a castle. Everyone in the room watches it go up block by block.
				</p>
				<div className="hero-actions">
					<button type="button" className="cta" onClick={createRoom} disabled={creating || me === null}>
						{creating ? 'Creating…' : 'Create a room'}
					</button>
					<button type="button" className="cta ghost" onClick={async () => { if (await ensureName()) navigate('/r/main') }}>
						Join the main world
					</button>
					<a className="cta ghost" href={`${appBase}/api`}>
						Let your agent build
					</a>
					{signedOut && me?.displayName ? <p className="hint">You'll build as <strong>{me.displayName}</strong>. <button type="button" className="linkish" onClick={rename}>Change name</button> (no account needed)</p> : null}
					{error ? (
						<p className="hint error" role="alert">
							{error}
						</p>
					) : null}
				</div>
				<ul className="features">
					<li>
						<PersonIcon />
						<span>
							<strong>One-click rooms</strong> with a private share link
						</span>
					</li>
					<li>
						<BotIcon />
						<span>
							<strong>Bring your own agent</strong> with a simple HTTP API, no account needed
						</span>
					</li>
					<li>
						<SyncIcon state="synced" />
						<span>
							<strong>Live sync</strong> for every block, powered by PowerSync
						</span>
					</li>
				</ul>
			</main>
			<footer className="landing-foot">
				Powered by <a href="https://www.powersync.com" target="_blank" rel="noreferrer">PowerSync</a> and{' '}
				<a href="https://neon.tech" target="_blank" rel="noreferrer">Neon</a> on{' '}
				<a href="https://workers.cloudflare.com" target="_blank" rel="noreferrer">Cloudflare Workers</a>
			</footer>
		</div>
	)
}
