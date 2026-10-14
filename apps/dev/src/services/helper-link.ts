import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { trackMentionGuardDecision } from '../lib/analytics/mention-guard-events'
import { logger } from '../lib/logger'
import { MENTION_GUARD_LIMITS, readHopDepth } from './mention-guards'
import { TERMINAL_STATUSES } from './session-lifecycle'

/**
 * Decide whether a new session may be linked to the session that claims to
 * have started it (sessions.spawned_by_session_id).
 *
 * The claim arrives as the X-Maskin-Session-Id header, which is only checked for
 * shape, and /mcp sits outside the auth middleware. So the link is set only when
 * the claimed session belongs to the authenticated caller, lives in the same
 * workspace and has not finished. Anything else leaves the link null and is
 * logged; the work itself still runs. Without this check any key holder could
 * name another agent's live session and make us wake it later.
 *
 * The result also carries the hop depth the new session should store in
 * config.hop_depth: the sender's depth plus 1. A link that would sit deeper than
 * MENTION_GUARD_LIMITS.maxHopDepth is dropped (reason 'hop_cap').
 */
export type SpawnLink =
	| { linked: true; spawnedBySessionId: string; hopDepth: number }
	| { linked: false; reason: SpawnLinkRefusal | null }

export type SpawnLinkRefusal =
	| 'unknown_session'
	| 'other_workspace'
	| 'not_callers_session'
	| 'sender_terminal'
	| 'hop_cap'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function resolveSpawnLink(
	db: Database,
	ctx: {
		claimedSessionId: string | null | undefined
		/** The authenticated actor: the API key's actor, or the mention's comment author. */
		authenticatedActorId: string
		workspaceId: string
		/** Object the new session is for, only to tag the guard event. */
		objectId?: string | null
	},
): Promise<SpawnLink> {
	if (!ctx.claimedSessionId) return { linked: false, reason: null }
	if (!UUID_RE.test(ctx.claimedSessionId)) return { linked: false, reason: 'unknown_session' }

	const [sender] = await db
		.select({
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			status: sessions.status,
			config: sessions.config,
		})
		.from(sessions)
		.where(eq(sessions.id, ctx.claimedSessionId))
		.limit(1)

	const refuse = (reason: SpawnLinkRefusal): SpawnLink => {
		logger.warn('Session link refused', {
			claimed_session_id: ctx.claimedSessionId,
			authenticated_actor_id: ctx.authenticatedActorId,
			workspace_id: ctx.workspaceId,
			reason,
		})
		return { linked: false, reason }
	}

	if (!sender) return refuse('unknown_session')
	if (sender.workspaceId !== ctx.workspaceId) return refuse('other_workspace')
	if (sender.actorId !== ctx.authenticatedActorId) return refuse('not_callers_session')
	if ((TERMINAL_STATUSES as readonly string[]).includes(sender.status)) {
		return refuse('sender_terminal')
	}

	const hopDepth = readHopDepth(sender.config) + 1
	if (hopDepth > MENTION_GUARD_LIMITS.maxHopDepth) {
		await trackMentionGuardDecision({
			workspaceId: ctx.workspaceId,
			targetActorId: ctx.authenticatedActorId,
			objectId: ctx.objectId ?? '',
			result: 'blocked',
			reason: 'hop_cap',
		})
		return refuse('hop_cap')
	}
	return { linked: true, spawnedBySessionId: ctx.claimedSessionId, hopDepth }
}
