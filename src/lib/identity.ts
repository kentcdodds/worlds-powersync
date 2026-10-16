import { kody } from './platform.ts'
import { timed } from './timing.ts'
import { cleanText, colorFor, slugify } from '../shared/world-rules.ts'

export type Caller = { username: string; displayName: string }

/** The signed-in Kody person behind this request, or null for anonymous. */
export async function getCaller(): Promise<Caller | null> {
	try {
		const me = (await timed('caller', () => kody.metaGetCurrentUser({}))) as {
			username?: string
			displayName?: string
		}
		if (!me?.username) return null
		return {
			username: me.username,
			displayName: cleanText(me.displayName || me.username, 40) || me.username,
		}
	} catch {
		return null
	}
}

export type PlayerIdentity = {
	id: string
	kind: 'human' | 'agent'
	ownerId: string
	displayName: string
	color: string
}

export function humanPlayer(caller: Caller): PlayerIdentity {
	const id = `u:${caller.username}`
	return {
		id,
		kind: 'human',
		ownerId: caller.username,
		displayName: caller.displayName,
		color: colorFor(id),
	}
}

/** An agent acting for `caller`, shown as "<First name>'s <Agent>". */
export function agentPlayer(caller: Caller, agentName: unknown): PlayerIdentity {
	const name = cleanText(agentName, 24) || 'Agent'
	const id = `a:${caller.username}:${slugify(name)}`
	const first = caller.displayName.split(/\s+/)[0] || caller.username
	return {
		id,
		kind: 'agent',
		ownerId: caller.username,
		displayName: `${first}'s ${name}`,
		color: colorFor(id),
	}
}
