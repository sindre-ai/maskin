// Session actor-identity context for loop-driven sandboxes.
//
// A loop's session runs in a microVM whose env carries the driver actor's
// identity through two pieces set by apps/dev on POST /sessions:
//
//   MASKIN_ACTOR_ID   the driver actor's UUID
//   MASKIN_API_KEY    the bearer token (ank_*) whose lookup in the actors
//                     table resolves to the same actorId
//
// This helper is the single documented shape for that pair on the
// agent-server side, so a caller wiring a loop-driven session doesn't have to
// remember two env-var names or re-derive the validation. The session's
// outbound MCP calls hit apps/dev with
//
//   Authorization: Bearer $MASKIN_API_KEY
//
// packages/auth's authMiddleware resolves it, and Hono handlers see
// `c.get('actorId') === MASKIN_ACTOR_ID`. End-to-end, the actorId on the API
// key IS the loop's driver actor — this file is the confirmation surface for
// the parent bet's spec residual 3.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const API_KEY_PREFIX = 'ank_'

export interface SessionActorContext {
	actorId: string
	apiKey: string
}

// Returns the driver-actor context iff both env vars are present, well-shaped,
// and belong together (UUID + `ank_` bearer). Returns null otherwise so a
// missing pair on an interactive (human-driven) session is not an error — only
// loop-driven sessions ever set both. Never throws.
export function readSessionActorContext(
	env: Record<string, string | undefined>,
): SessionActorContext | null {
	const actorId = env.MASKIN_ACTOR_ID?.trim()
	const apiKey = env.MASKIN_API_KEY?.trim()
	if (!actorId || !apiKey) return null
	if (!UUID_RE.test(actorId)) return null
	if (!apiKey.startsWith(API_KEY_PREFIX)) return null
	return { actorId, apiKey }
}
