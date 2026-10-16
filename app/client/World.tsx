import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import { BOUNDS, MATERIALS, inBounds } from '../../src/shared/world-rules.ts'
import type { BlockRow, BuildRow, PlayerRow } from './powersync.ts'

export type Cell = { x: number; y: number; z: number }
export type Mode = 'place' | 'remove'

const box = new THREE.BoxGeometry(1, 1, 1)
const materialByKey = new Map(
	MATERIALS.map((m) => [
		m.key,
		new THREE.MeshStandardMaterial({
			color: m.color,
			roughness: 0.85,
			metalness: m.key === 'gold' ? 0.4 : 0,
			transparent: m.opacity != null,
			opacity: m.opacity ?? 1,
			emissive: m.emissive ?? '#000000',
			depthWrite: m.opacity == null,
		}),
	]),
)

function shade(id: string) {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0
	return 0.9 + ((Math.abs(h) % 100) / 100) * 0.12
}

const ANIM_MS = 380

function BlockLayer({
	material,
	blocks,
	bornAt,
	onPointer,
}: {
	material: string
	blocks: Array<BlockRow>
	bornAt: Map<string, number>
	onPointer: (e: ThreeEvent<PointerEvent | MouseEvent>, block: BlockRow | null, kind: 'move' | 'click' | 'context') => void
}) {
	const ref = useRef<THREE.InstancedMesh>(null)
	const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(blocks.length + 1)))
	const tmp = useMemo(() => new THREE.Object3D(), [])
	const color = useMemo(() => new THREE.Color(), [])

	useLayoutEffect(() => {
		const mesh = ref.current
		if (!mesh) return
		const now = performance.now()
		blocks.forEach((b, i) => {
			const born = bornAt.get(b.id)
			const t = born ? Math.min(1, (now - born) / ANIM_MS) : 1
			tmp.position.set(b.x, b.y + (1 - t) * 1.5, b.z)
			tmp.scale.setScalar(0.3 + 0.7 * t)
			tmp.updateMatrix()
			mesh.setMatrixAt(i, tmp.matrix)
			color.setScalar(shade(b.id))
			mesh.setColorAt(i, color)
		})
		mesh.count = blocks.length
		mesh.instanceMatrix.needsUpdate = true
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
		mesh.computeBoundingSphere()
	}, [blocks, bornAt, tmp, color])

	useFrame(() => {
		const mesh = ref.current
		if (!mesh || bornAt.size === 0) return
		const now = performance.now()
		let dirty = false
		blocks.forEach((b, i) => {
			const born = bornAt.get(b.id)
			if (!born) return
			const t = Math.min(1, (now - born) / ANIM_MS)
			const e = 1 - Math.pow(1 - t, 3)
			tmp.position.set(b.x, b.y + (1 - e) * 1.5, b.z)
			tmp.scale.setScalar(0.3 + 0.7 * e)
			tmp.updateMatrix()
			mesh.setMatrixAt(i, tmp.matrix)
			dirty = true
			if (t >= 1) bornAt.delete(b.id)
		})
		if (dirty) mesh.instanceMatrix.needsUpdate = true
	})

	const mat = materialByKey.get(material as never) ?? materialByKey.get('stone')!
	return (
		<instancedMesh
			ref={ref}
			args={[box, mat, capacity]}
			frustumCulled={false}
			onPointerMove={(e) => onPointer(e, e.instanceId != null ? blocks[e.instanceId] ?? null : null, 'move')}
			onClick={(e) => onPointer(e, e.instanceId != null ? blocks[e.instanceId] ?? null : null, 'click')}
			onContextMenu={(e) => onPointer(e, e.instanceId != null ? blocks[e.instanceId] ?? null : null, 'context')}
		/>
	)
}

function Controls() {
	const { camera, gl } = useThree()
	const controls = useMemo(() => new OrbitControlsImpl(camera, gl.domElement), [camera, gl])
	useEffect(() => {
		controls.target.set(0, 3, 0)
		const aspect = gl.domElement.clientWidth / Math.max(1, gl.domElement.clientHeight)
		if (aspect < 0.9) camera.position.multiplyScalar(1.7)
		controls.enableDamping = true
		controls.dampingFactor = 0.08
		controls.maxPolarAngle = Math.PI * 0.47
		controls.minDistance = 6
		controls.maxDistance = 140
		controls.update()
		return () => controls.dispose()
	}, [controls, camera, gl])
	useFrame(() => controls.update())
	return null
}

function labelTexture(text: string, color: string) {
	const canvas = document.createElement('canvas')
	const ctx = canvas.getContext('2d')!
	ctx.font = '600 44px system-ui, sans-serif'
	const w = Math.ceil(ctx.measureText(text).width) + 48
	canvas.width = w
	canvas.height = 76
	ctx.font = '600 44px system-ui, sans-serif'
	ctx.fillStyle = 'rgba(12,16,26,0.82)'
	ctx.beginPath()
	ctx.roundRect(0, 0, w, 76, 38)
	ctx.fill()
	ctx.fillStyle = color
	ctx.beginPath()
	ctx.arc(30, 38, 11, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = '#fff'
	ctx.fillText(text, 50, 53)
	const tex = new THREE.CanvasTexture(canvas)
	tex.colorSpace = THREE.SRGBColorSpace
	return { tex, aspect: w / 76 }
}

function Label({ text, color, position }: { text: string; color: string; position: [number, number, number] }) {
	const { tex, aspect } = useMemo(() => labelTexture(text, color), [text, color])
	useEffect(() => () => tex.dispose(), [tex])
	return (
		<sprite position={position} scale={[0.9 * aspect, 0.9, 1]} renderOrder={10}>
			<spriteMaterial map={tex} depthTest={false} transparent />
		</sprite>
	)
}

function Marker({ player, at }: { player: PlayerRow; at: Cell }) {
	const ref = useRef<THREE.Group>(null)
	useFrame(({ clock }) => {
		if (ref.current) ref.current.position.y = at.y + 1.6 + Math.sin(clock.elapsedTime * 3) * 0.15
	})
	return (
		<group ref={ref} position={[at.x, at.y + 1.6, at.z]}>
			<mesh rotation={[0, 0, Math.PI / 4]}>
				<octahedronGeometry args={[0.35]} />
				<meshStandardMaterial color={player.color} emissive={player.color} emissiveIntensity={0.6} />
			</mesh>
			<Label text={player.display_name} color={player.color} position={[0, 0.9, 0]} />
		</group>
	)
}

export function World(props: {
	blocks: Array<BlockRow>
	players: Array<PlayerRow>
	builds: Array<BuildRow>
	meId: string | null
	mode: Mode
	canEdit: boolean
	onPlace: (cell: Cell) => void
	onRemove: (block: BlockRow) => void
	onHover: (cell: Cell | null) => void
}) {
	const { blocks, players, builds, meId, mode, canEdit } = props
	const bornAt = useRef(new Map<string, number>()).current
	const seen = useRef<Set<string> | null>(null)
	const [ghost, setGhost] = useState<{ cell: Cell; remove: boolean } | null>(null)

	// Animate blocks that appear after the first render.
	const known = seen.current
	if (known === null) {
		seen.current = new Set(blocks.map((b) => b.id))
	} else {
		const now = performance.now()
		const next = new Set<string>()
		for (const b of blocks) {
			next.add(b.id)
			if (!known.has(b.id)) bornAt.set(b.id, now)
		}
		seen.current = next
	}

	const byMaterial = useMemo(() => {
		const map = new Map<string, Array<BlockRow>>()
		for (const b of blocks) {
			const list = map.get(b.material) ?? []
			list.push(b)
			map.set(b.material, list)
		}
		return map
	}, [blocks])

	// Live agent markers: latest block of each agent with an active build.
	const markers = useMemo(() => {
		const active = new Set(builds.filter((b) => b.status === 'building' || b.status === 'planning').map((b) => b.author_id))
		const latest = new Map<string, BlockRow>()
		for (const b of blocks) {
			if (!b.placed_by || !active.has(b.placed_by)) continue
			const cur = latest.get(b.placed_by)
			if (!cur || (b.seq ?? 0) > (cur.seq ?? 0)) latest.set(b.placed_by, b)
		}
		return players
			.filter((p) => p.kind === 'agent' && latest.has(p.id))
			.map((p) => ({ player: p, at: latest.get(p.id)! }))
	}, [blocks, builds, players])

	const cursors = players.filter(
		(p) =>
			p.id !== meId &&
			p.kind === 'human' &&
			p.cursor_x != null &&
			p.last_seen != null &&
			Date.now() - Date.parse(p.last_seen.replace(' ', 'T') + (p.last_seen.endsWith('Z') || /[+-]\d\d(:?\d\d)?$/.test(p.last_seen) ? '' : 'Z')) < 90_000,
	)

	const targetFor = (e: ThreeEvent<PointerEvent | MouseEvent>, block: BlockRow | null, remove: boolean) => {
		if (block) {
			if (remove) return { cell: { x: block.x, y: block.y, z: block.z }, block }
			const n = e.face?.normal
			if (!n) return null
			const cell = { x: block.x + Math.round(n.x), y: block.y + Math.round(n.y), z: block.z + Math.round(n.z) }
			return inBounds(cell.x, cell.y, cell.z) ? { cell, block: null } : null
		}
		if (remove) return null
		const cell = { x: Math.round(e.point.x), y: 0, z: Math.round(e.point.z) }
		return inBounds(cell.x, cell.y, cell.z) ? { cell, block: null } : null
	}

	const handle = (e: ThreeEvent<PointerEvent | MouseEvent>, block: BlockRow | null, kind: 'move' | 'click' | 'context') => {
		e.stopPropagation()
		if (!canEdit) return
		const native = e.nativeEvent as MouseEvent
		const remove = kind === 'context' || mode === 'remove' || native.shiftKey || native.altKey
		const target = targetFor(e, block, remove)
		if (kind === 'move') {
			setGhost(target ? { cell: target.cell, remove } : null)
			props.onHover(target?.cell ?? null)
			return
		}
		if (kind === 'context') native.preventDefault?.()
		if (e.delta > 6) return // was a drag
		if (!target) return
		if (remove && target.block) props.onRemove(target.block)
		else if (!remove) props.onPlace(target.cell)
	}

	const sizeX = BOUNDS.maxX - BOUNDS.minX + 1
	const sizeZ = BOUNDS.maxZ - BOUNDS.minZ + 1
	const centerX = (BOUNDS.maxX + BOUNDS.minX) / 2
	const centerZ = (BOUNDS.maxZ + BOUNDS.minZ) / 2

	return (
		<Canvas
			camera={{ position: [26, 24, 30], fov: 50, near: 0.1, far: 600 }}
			dpr={[1, 2]}
			onContextMenu={(e) => e.preventDefault()}
			onPointerMissed={() => {
				setGhost(null)
				props.onHover(null)
			}}
		>
			<color attach="background" args={['#9fc9ee']} />
			<fog attach="fog" args={['#9fc9ee', 90, 220]} />
			<hemisphereLight args={['#ffffff', '#5b6b4a', 1.1]} />
			<directionalLight position={[30, 50, 20]} intensity={1.4} />
			<Controls />
			<mesh
				rotation={[-Math.PI / 2, 0, 0]}
				position={[centerX, -0.5, centerZ]}
				onPointerMove={(e) => handle(e, null, 'move')}
				onClick={(e) => handle(e, null, 'click')}
			>
				<planeGeometry args={[sizeX, sizeZ]} />
				<meshStandardMaterial color="#6fae5a" roughness={1} />
			</mesh>
			<gridHelper args={[sizeX, sizeX, '#64a252', '#64a252']} position={[centerX, -0.49, centerZ]} />
			{[...byMaterial.entries()].map(([material, list]) => (
				<BlockLayer key={material} material={material} blocks={list} bornAt={bornAt} onPointer={handle} />
			))}
			{ghost ? (
				<mesh position={[ghost.cell.x, ghost.cell.y, ghost.cell.z]} raycast={() => null}>
					<boxGeometry args={[1.04, 1.04, 1.04]} />
					<meshBasicMaterial color={ghost.remove ? '#ff4d4f' : '#ffffff'} transparent opacity={0.35} depthWrite={false} />
				</mesh>
			) : null}
			{cursors.map((p) => (
				<group key={p.id} position={[p.cursor_x!, p.cursor_y!, p.cursor_z!]}>
					<mesh raycast={() => null}>
						<boxGeometry args={[1.06, 1.06, 1.06]} />
						<meshBasicMaterial color={p.color} wireframe />
					</mesh>
					<Label text={p.display_name} color={p.color} position={[0, 1.2, 0]} />
				</group>
			))}
			{markers.map((m) => (
				<Marker key={m.player.id} player={m.player} at={m.at} />
			))}
		</Canvas>
	)
}
