import type { Database } from '@maskin/db'
import { actors, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Name of the Chief of Staff agent seeded into every workspace at creation —
 * the actor of last resort for case 3 dispatch when a commented object has no
 * driver (or the only candidate driver is the comment author). Load-bearing
 * per spec — see `always-a-responder-rule-shaping.md` §Solution sketch case 3.
 *
 * Resolved per workspace, NOT hardcoded to one actor id. Every workspace gets
 * its own Chief of Staff row at creation and keeps it for the workspace's
 * lifetime, so a single global id is only ever correct in the one workspace it
 * came from — everywhere else case 3 dispatched to a nonexistent actor and
 * failed inside `dispatchCommentFallback`'s catch, silently. Resolution
 * mirrors `lib/onboarding/signup-welcome.ts`'s `resolveAgentIdByName`, which
 * is how the same agent is already located at signup.
 */
export const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

/**
 * Who the comment-fallback ladder will dispatch to for a given comment, or why
 * it will not dispatch at all.
 *
 * `driver` / `cos` carry the actor that WILL receive a `comment_fallback`
 * session; `no_responder` / `self_authored` are the two no-dispatch outcomes,
 * kept distinct because `CommentDispatcher` reports them as different
 * `comment_responder_resolved` cases.
 */
export type CommentFallbackResponder =
	| { kind: 'driver'; actorId: string }
	| { kind: 'cos'; actorId: string }
	| { kind: 'no_responder' }
	| { kind: 'self_authored' }

/**
 * Resolves the workspace's own Chief of Staff. Matched on name + agent type
 * through `workspace_members`, the same way `signup-welcome.ts` locates it.
 * Oldest membership wins so the answer is stable for the workspace's lifetime
 * if a second same-named agent is ever added.
 */
export async function resolveChiefOfStaffId(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_NAME),
				eq(actors.type, 'agent'),
			),
		)
		.orderBy(actors.createdAt)
		.limit(1)
	return row?.actorId ?? null
}

/**
 * Single source of truth for "which actor does the case-2 / case-3 fallback
 * ladder pick for this comment".
 *
 * TWO callers, deliberately:
 *   • `CommentDispatcher.handleFallback` (`services/trigger-runner.ts`) — to
 *     actually dispatch the session.
 *   • `spawnThreadReplySessions` (`routes/events.ts`) — to EXCLUDE that actor
 *     from the thread-reply auto-spawn, so one comment cannot queue two
 *     sessions for the same agent.
 *
 * The two run in different processes-worth of context (an inline route handler
 * and a PG NOTIFY subscriber) but read the same committed rows, so both reach
 * the same answer without coordinating — this is a deterministic function of
 * DB state, not a race. Keeping it in one function is what stops the two
 * paths from drifting apart again; a change to the ladder's eligibility rules
 * must land here, where both callers see it.
 *
 * Only meaningful when the comment carries NO mentions — the ladder is not
 * reached otherwise (mentions short-circuit into `handleMentions`). Callers
 * are responsible for that gate.
 */
export async function resolveCommentFallbackResponder(
	db: Database,
	ctx: {
		workspaceId: string
		/** The commented object's id. Must be a uuid that exists in `objects`. */
		entityId: string
		/** Author of the new comment. */
		commenterId: string
		/** Author of the (root) parent comment, when this comment is a reply. */
		parentAuthorId: string | null
	},
): Promise<CommentFallbackResponder> {
	const [obj] = await db
		.select({ driver: objects.driver })
		.from(objects)
		.where(eq(objects.id, ctx.entityId))
		.limit(1)
	const driverId = obj?.driver ?? null

	// Case 2 — driver fallback. Loop-safety option (a): also blocked when the
	// driver authored the PARENT comment we're replying to — otherwise an agent
	// that drives its own bet would ping itself on every reply.
	if (driverId && driverId !== ctx.commenterId && driverId !== ctx.parentAuthorId) {
		return { kind: 'driver', actorId: driverId }
	}

	// Case 3 — Chief of Staff fallback.
	const cosActorId = await resolveChiefOfStaffId(db, ctx.workspaceId)
	if (!cosActorId) return { kind: 'no_responder' }
	if (cosActorId === ctx.commenterId || cosActorId === ctx.parentAuthorId) {
		return { kind: 'self_authored' }
	}
	return { kind: 'cos', actorId: cosActorId }
}

/**
 * The actor the fallback ladder will dispatch to, or `null` when it will not
 * dispatch. Convenience wrapper for the exclusion-set caller, which does not
 * care WHY there is no responder.
 */
export function fallbackResponderActorId(responder: CommentFallbackResponder): string | null {
	return responder.kind === 'driver' || responder.kind === 'cos' ? responder.actorId : null
}
