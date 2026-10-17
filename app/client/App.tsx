import { apiFetch, chooseName } from './nav.ts'
import { useQuery, useStatus, usePowerSync } from '@powersync/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentPrompt } from '../../src/shared/agent-prompt.ts'
import { MATERIALS, blockId, type MaterialKey, SOURCE_URL } from '../../src/shared/world-rules.ts'
import { BotIcon, GitHubIcon, PanelIcon, PersonIcon, PlaceIcon, RemoveIcon, SyncIcon } from './icons.tsx'
import type { BlockRow, BuildRow, PlayerRow } from './powersync.ts'
import { World, type Cell, type Mode } from './World.tsx'

export type Session = {
	signedIn: boolean
	guest?: boolean
	worldId: string
	powersyncUrl: string
	player?: { id: string; displayName: string; color: string }
}

export type Room = { slug: string; name: string; worldId: string; isOwner: boolean }

const appBase = document.documentElement.dataset.appBase ?? ''

function RoomName({ room, name }: { room: Room; name: string }) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(name)
	const [saving, setSaving] = useState(false)
	if (!room.isOwner) return <span className="world-name">{name}</span>
	if (!editing) {
		return (
			<button type="button" className="world-name editable" title="Rename room" onClick={() => (setDraft(name), setEditing(true))}>
				{name}
				<span className="edit-hint" aria-hidden="true">✎</span>
			</button>
		)
	}
	async function save() {
		const next = draft.trim()
		if (!next || next === name) return setEditing(false)
		setSaving(true)
		await apiFetch(`${appBase}/api/rooms/${room.slug}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: next }),
		}).catch(() => null)
		setSaving(false)
		setEditing(false)
	}
	return (
		<form
			className="rename"
			onSubmit={(e) => {
				e.preventDefault()
				void save()
			}}
		>
			<input
				autoFocus
				aria-label="Room name"
				value={draft}
				maxLength={40}
				disabled={saving}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => void save()}
				onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
			/>
		</form>
	)
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		const ta = document.createElement('textarea')
		ta.value = text
		ta.setAttribute('readonly', '')
		ta.style.position = 'fixed'
		ta.style.opacity = '0'
		document.body.appendChild(ta)
		ta.select()
		const ok = document.execCommand('copy')
		ta.remove()
		return ok
	}
}

function useCopied() {
	const [copied, setCopied] = useState<string | null>(null)
	useEffect(() => {
		if (!copied) return
		const t = setTimeout(() => setCopied(null), 2200)
		return () => clearTimeout(t)
	}, [copied])
	return [copied, setCopied] as const
}

function useNow(ms: number) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(t)
	}, [ms])
	return now
}

const parseTime = (s: string | null) => {
	if (!s) return 0
	const iso = s.includes('T') ? s : s.replace(' ', 'T')
	return Date.parse(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(iso) ? iso : iso + 'Z')
}

export function App({ session, initialRoom }: { session: Session; initialRoom: Room }) {
	const db = usePowerSync()
	const status = useStatus()
	const worldId = initialRoom.worldId
	const me = session.player ?? null
	const canEdit = !!me
	const [mode, setMode] = useState<Mode>('place')
	const [material, setMaterial] = useState<MaterialKey>('stone')
	const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 900px)').matches)
	const now = useNow(5000)

	const { data: blocks } = useQuery<BlockRow>(
		'SELECT id, world_id, x, y, z, material, build_id, placed_by, seq FROM blocks WHERE world_id = ?',
		[worldId],
	)
	const { data: players } = useQuery<PlayerRow>('SELECT * FROM players WHERE world_id = ? ORDER BY display_name', [worldId])
	const { data: builds } = useQuery<BuildRow>(
		'SELECT * FROM builds WHERE world_id = ? ORDER BY created_at DESC LIMIT 20',
		[worldId],
	)
	const { data: worldRows } = useQuery<{ id: string; name: string }>('SELECT id, name FROM worlds WHERE id = ?', [worldId])
	const worldName = worldRows[0]?.name ?? initialRoom.name
	const roomUrl = `${location.origin}${appBase}/r/${initialRoom.slug}`
	const [copied, setCopied] = useCopied()
	const copyPrompt = async () => {
		const text = agentPrompt({
			apiBase: `${location.origin}${appBase}`,
			roomUrl,
			roomCode: initialRoom.slug,
			roomName: worldName,
			userName: me?.displayName ?? 'Me',
		})
		;(window as unknown as { __wbPrompt: string }).__wbPrompt = text
		if (await copyText(text)) setCopied('prompt')
	}
	const copyLink = async () => {
		if (await copyText(roomUrl)) setCopied('link')
	}

	const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players])
	const online = players.filter((p) => {
		const seen = parseTime(p.last_seen)
		const building = builds.some((b) => b.author_id === p.id && (b.status === 'building' || b.status === 'planning'))
		return p.id === me?.id || building || now - seen < 120_000
	})

	const place = useCallback(
		async (cell: Cell) => {
			if (!me) return
			const id = blockId(worldId, cell.x, cell.y, cell.z)
			await db.writeTransaction(async (tx) => {
				const existing = await tx.getOptional('SELECT id FROM blocks WHERE id = ?', [id])
				if (existing) {
					await tx.execute('UPDATE blocks SET material = ?, placed_by = ?, build_id = NULL WHERE id = ?', [material, me.id, id])
				} else {
					await tx.execute(
						'INSERT INTO blocks (id, world_id, x, y, z, material, placed_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
						[id, worldId, cell.x, cell.y, cell.z, material, me.id],
					)
				}
			})
		},
		[db, me, worldId, material],
	)
	const remove = useCallback(
		async (block: BlockRow) => {
			await db.execute('DELETE FROM blocks WHERE id = ?', [block.id])
		},
		[db],
	)

	// Share my cursor (every 200 ms when it moves; remote views ease between updates) so others see where I'm pointing.
	const pendingCursor = useRef<Cell | null | undefined>(undefined)
	useEffect(() => {
		if (!me) return
		let last = ''
		const t = setInterval(() => {
			const c = pendingCursor.current
			if (c === undefined) return
			const key = c ? `${c.x}:${c.y}:${c.z}` : 'none'
			if (key === last) return
			last = key
			// Not a PowerSync write: cursors go straight to the server so they never
			// queue ahead of block edits in the upload queue.
			void apiFetch(`${appBase}/api/cursor`, {
				method: 'POST',
				keepalive: true,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ worldId, x: c?.x ?? null, y: c?.y ?? null, z: c?.z ?? null }),
			}).catch(() => {})
		}, 200)
		return () => clearInterval(t)
	}, [db, me, worldId])
	const onHover = useCallback((cell: Cell | null) => {
		pendingCursor.current = cell
	}, [])

	const syncState: 'synced' | 'syncing' | 'offline' = !status.connected
		? 'offline'
		: status.dataFlowStatus?.uploading || status.dataFlowStatus?.downloading || !status.hasSynced
			? 'syncing'
			: 'synced'
	const syncLabel = { synced: 'Live', syncing: 'Syncing', offline: 'Offline' }[syncState]

	return (
		<div className={`app ${panelOpen ? 'panel-open' : ''}`}>
			<header className="topbar">
				<div className="brand">
					<img src={`${document.documentElement.dataset.assetBase}/icon.png`} alt="" width={28} height={28} />
					<div className="brand-text">
						<strong>World Builder</strong>
						<RoomName room={initialRoom} name={worldName} />
					</div>
				</div>
				<div className="top-right">
					<button type="button" className="chip" onClick={copyLink} title="Copy the room link to share it">
						{copied === 'link' ? 'Link copied!' : 'Share'}
					</button>
					{canEdit ? (
						<button type="button" className="chip primary" onClick={copyPrompt} title="Copy a prompt that teaches your agent to build in this room">
							<BotIcon />
							<span className="chip-label">{copied === 'prompt' ? 'Copied!' : 'Copy prompt for your agent'}</span>
						</button>
					) : (
						<a className="chip primary" href={`${appBase}/api`} target="_blank" rel="noreferrer">
							Let your agent build
						</a>
					)}
					<a className="chip" href={SOURCE_URL} target="_blank" rel="noreferrer" title="View the source code on GitHub">
						<GitHubIcon />
						<span className="chip-label">Source code</span>
					</a>
					<div className="avatars" aria-label={`${online.length} builders online`}>
						{online.slice(0, 5).map((p) => (
							<span key={p.id} className="avatar" style={{ background: p.color }} title={p.display_name}>
								{p.kind === 'agent' ? <BotIcon /> : initials(p.display_name)}
							</span>
						))}
						{online.length > 5 ? <span className="avatar more">+{online.length - 5}</span> : null}
					</div>
					<span className={`sync ${syncState}`} title={`Sync: ${syncLabel}`} aria-label={`Sync status: ${syncLabel}`}>
						<SyncIcon state={syncState} />
					</span>
					<button
						type="button"
						className="chip"
						title="Change the name other builders see"
						onClick={async () => {
							if (await chooseName(me?.displayName)) location.reload()
						}}
					>
						{me?.displayName ?? 'Name'} ✎
					</button>
					<button type="button" className="icon-btn" onClick={() => setPanelOpen((v) => !v)} aria-label="Toggle side panel" aria-pressed={panelOpen}>
						<PanelIcon />
					</button>
				</div>
			</header>

			<main className="stage">
				<World
					blocks={blocks}
					players={players}
					builds={builds}
					meId={me?.id ?? null}
					mode={mode}
					canEdit={canEdit}
					onPlace={place}
					onRemove={remove}
					onHover={onHover}
				/>
				{!status.hasSynced ? (
					<div className="stage-overlay" aria-hidden="true">
						<div className="boot-cube" />
					</div>
				) : null}
				{!canEdit ? <div className="banner">Connecting… reload if you can't build.</div> : null}
				{copied === 'prompt' ? (
					<div className="toast" role="status">
						Copied! Paste it into Claude, ChatGPT or Grok, then ask for a castle.
					</div>
				) : null}
			</main>

			{canEdit ? <nav className="toolbar" aria-label="Build tools">
				<div className="modes" role="radiogroup" aria-label="Mode">
					<button type="button" role="radio" aria-checked={mode === 'place'} className={mode === 'place' ? 'on' : ''} onClick={() => setMode('place')} title="Place blocks">
						<PlaceIcon />
					</button>
					<button type="button" role="radio" aria-checked={mode === 'remove'} className={mode === 'remove' ? 'on' : ''} onClick={() => setMode('remove')} title="Remove blocks (or right-click / shift-click)">
						<RemoveIcon />
					</button>
				</div>
				<div className="palette" role="radiogroup" aria-label="Block">
					{MATERIALS.map((m) => (
						<button
							key={m.key}
							type="button"
							role="radio"
							aria-checked={material === m.key}
							aria-label={m.label}
							title={m.label}
							className={`swatch ${material === m.key ? 'on' : ''}`}
							style={{ background: m.color, opacity: m.opacity ? 0.75 : 1 }}
							onClick={() => {
								setMaterial(m.key)
								setMode('place')
							}}
						/>
					))}
				</div>
			</nav> : null}

			<aside className="panel" aria-label="World activity">
				<section>
					<h2>Builders <span className="count">{online.length}</span></h2>
					<ul className="people">
						{online.length === 0 ? <li className="muted">Nobody here yet.</li> : null}
						{online.map((p) => (
							<li key={p.id}>
								<span className="dot" style={{ background: p.color }} />
								<span className="kind">{p.kind === 'agent' ? <BotIcon /> : <PersonIcon />}</span>
								<span className="name">{p.display_name}</span>
								{p.id === me?.id ? <span className="pill">you</span> : null}
							</li>
						))}
					</ul>
				</section>
				<section>
					<h2>Build feed</h2>
					<ul className="feed">
						{builds.length === 0 ? (
							<li className="muted">No agent builds yet. Ask your agent to build something!</li>
						) : null}
						{builds.map((b) => {
							const author = playerById.get(b.author_id)
							const active = b.status === 'building' || b.status === 'planning'
							return (
								<li key={b.id} className={active ? 'active' : ''}>
									<div className="feed-head">
										<span className="dot" style={{ background: author?.color ?? '#888' }} />
										<span className="name">{author?.display_name ?? 'An agent'}</span>
										<span className={`status ${b.status}`}>{active ? 'building' : b.status}</span>
									</div>
									{b.prompt ? <p className="prompt">{b.prompt}</p> : null}
									<div className="feed-meta">{b.block_count.toLocaleString()} blocks</div>
								</li>
							)
						})}
					</ul>
				</section>
				<section className="howto">
					<h2>Bring your agent</h2>
					<p>
						Any agent that can make HTTP requests can build here, no account needed. Copy the prompt, paste it into Claude, ChatGPT or Grok, then ask: <em>"Build me a castle."</em> Its blocks stream in here live. <a href={`${appBase}/api`} target="_blank" rel="noreferrer">API docs</a>
					</p>
					{canEdit ? (
						<button type="button" className="cta small" onClick={copyPrompt}>
							{copied === 'prompt' ? 'Copied!' : 'Copy prompt for your agent'}
						</button>
					) : (
						<a className="cta small" href={`${appBase}/api`} target="_blank" rel="noreferrer">
							API docs
						</a>
					)}
					<p className="source-row">
						<a className="source-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
							<GitHubIcon /> Source code
						</a>
					</p>
				</section>
				<details className="details">
					<summary>Details</summary>
					<dl>
						<dt>Blocks</dt>
						<dd>{blocks.length.toLocaleString()}</dd>
						<dt>Room code</dt>
						<dd className="mono">{initialRoom.slug}</dd>
						<dt>World id</dt>
						<dd className="mono">{worldId}</dd>
						<dt>Your player</dt>
						<dd className="mono">{me?.id ?? 'spectator'}</dd>
						<dt>Sync</dt>
						<dd>
							{syncLabel}
							{status.lastSyncedAt ? ` · ${status.lastSyncedAt.toLocaleTimeString()}` : ''}
						</dd>
						<dt>PowerSync</dt>
						<dd className="mono">{new URL(session.powersyncUrl).host}</dd>
					</dl>
				</details>
			</aside>
		</div>
	)
}

function initials(name: string) {
	return name
		.split(/\s+/)
		.map((w) => w[0])
		.join('')
		.slice(0, 2)
		.toUpperCase()
}
