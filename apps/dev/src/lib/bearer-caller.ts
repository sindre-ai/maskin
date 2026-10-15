import { validateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'

export type BearerCaller = { actorId: string; actorType: string }

export type BearerCallerResult =
	| { ok: true; caller: BearerCaller }
	| { ok: false; reason: 'no_key' | 'invalid_key' }

/**
 * Resolve the calling actor from an `Authorization: Bearer ank_…` header, for
 * routes that sit on the auth-middleware allowlist and so have to authenticate
 * themselves (POST /api/actors for agents, invite accept). Only API keys are
 * accepted. Never reads X-Workspace-Id: callers that need a workspace must
 * check the caller's membership of the one they were told about.
 */
export async function resolveBearerCaller(
	db: Database,
	authHeader: string | undefined,
): Promise<BearerCallerResult> {
	if (!authHeader?.startsWith('Bearer ')) return { ok: false, reason: 'no_key' }
	const bearer = authHeader.slice(7).trim()
	if (!bearer.startsWith('ank_')) return { ok: false, reason: 'invalid_key' }
	const validated = await validateApiKey(db, bearer)
	if (!validated) return { ok: false, reason: 'invalid_key' }
	return { ok: true, caller: { actorId: validated.actorId, actorType: validated.type } }
}
