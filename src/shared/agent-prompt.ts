import { BOUNDS, LIMITS, MATERIALS } from './world-rules.ts'

/**
 * The self-contained prompt a person pastes into their agent so "build me a
 * castle" just works in their room. Uses the public HTTP API: no account, no
 * API key, any agent that can make HTTP requests (curl, fetch, a code tool).
 */
export function agentPrompt(input: { apiBase: string; roomUrl: string; roomCode: string; roomName: string; userName: string }) {
	const first = input.userName.split(/\s+/)[0] || input.userName
	const materials = MATERIALS.map((m) => m.key).join(', ')
	const api = `${input.apiBase}/api/v1/rooms/${input.roomCode}`
	return `You're joining a live, shared 3D voxel world in Kody World Builder: the room "${input.roomName}".
Room link: ${input.roomUrl}
Everyone in the room watches your blocks appear live as you place them.

HOW TO CALL IT
Plain HTTP + JSON. No account and no API key. Use curl, fetch, or any code/HTTP tool you have.
Full docs: ${input.apiBase}/llms.txt
For "agent", use a name like "${first}'s Claude" (your assistant name). The room lists you under it.

STEPS
1. Look before you build:
   GET ${api}
   Returns occupiedBounds, a heightMap of 8x8 cells (-1 = empty), and recentBuilds. Pick an empty spot.
   GET ${api}/blocks?minX=-8&maxX=8&minY=0&maxY=10&minZ=-8&maxZ=8 returns the exact blocks in an area.
2. Start a build (shows in the room's build feed):
   POST ${api}/builds   {"agent":"<name>","prompt":"<short description>"}   -> {"buildId":"..."}
3. Place blocks, from the ground up, a few hundred per request:
   POST ${api}/blocks   {"agent":"<name>","buildId":"...","place":[{"x":0,"y":0,"z":0,"material":"stone"}, ...]}
   To remove: same endpoint with "remove":[{"x":0,"y":0,"z":0}].
4. Finish:
   POST ${input.apiBase}/api/v1/builds/<buildId>/finish   {"status":"done"}

Example:
curl -s -X POST ${api}/blocks -H 'content-type: application/json' -d '{"agent":"Claude","place":[{"x":0,"y":0,"z":0,"material":"stone"}]}'

WORLD RULES
- The y axis points up, and the ground is y = 0. x runs ${BOUNDS.minX}..${BOUNDS.maxX}, z runs ${BOUNDS.minZ}..${BOUNDS.maxZ}, and y runs ${BOUNDS.minY}..${BOUNDS.maxY}. Integers only.
- Materials: ${materials}.
- Out-of-bounds blocks or unknown materials are skipped and counted in "rejected".
- Limits: ${LIMITS.maxApiOpsPerCall} block changes per request, about ${LIMITS.agentBlocksPerMinute} per minute per agent, ${LIMITS.maxBlocksPerWorld.toLocaleString('en-US')} blocks per room. On HTTP 429, wait a few seconds and continue where you stopped.
- Placing a block where one already exists replaces it. Don't build over other people's work unless you're asked to.

TIPS
- Plan the full structure as a list of blocks in code (loops for walls, floors and towers), then send it in chunks.
- A good castle is about 20x20 blocks and 900 to 1,200 blocks in total: a stone wall ring with crenellations, four taller towers, a gate, wood details, and a few glass windows.
- When you're done, tell me what you built and where (its x/z center).

Reply "Ready" and wait for my build request.`
}
