import type { Database } from '@maskin/db'
import { events, actors, sessions } from '@maskin/db/schema'
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm'
import {
	type MentionGuardReason,
	trackMentionGuardDecision,
} from '../lib/analytics/mention-guard-events'

/**
 * Loop guards for agent-authored @mentions and for helper returns.
 *
 * All the numbers live here, in one place. They are deliberately low and have
 * no data behind them yet: every decision is captured as a PostHog
 * mention_guard_decision event, so retune from real counts after a week.
 */
export const MENTION_GUARD_LIMITS = {
	/** Agent-authored mentions that may wake one agent on one object per window. */
	maxAgentMentionsPerWindow: 3,
	/** Sliding window for the mention cap and the return ceiling. */
	windowMs: 60 * 60 * 1000,
	/** Link depth above this is created without a link: the work runs, nothing returns. */
	maxHopDepth: 3,
	/** Returns one sender may receive on one object per window. */
	maxReturnsPerWindow: 10,
	/** Same author, same target, same text inside this window is a duplicate. */
	duplicateWindowMs: 60 * 60 * 1000,
	/** How many of the author's latest comments on the object the duplicate check reads. */
	duplicateLookback: 10,
} as const

export type MentionGuardDecision =
	| { allowed: true }
	| { allowed: false; reason: Extract<MentionGuardReason, 'mention_capped' | 'mention_duplicate'> }

/** Lowercase, drop @mention tokens, collapse whitespace. */
export function normalizeMentionText(text: string): string {
	return text.replace(/@\S+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Decide whether an agent-authored mention may start a session for the
 * mentioned agent. Returns are exempt from both checks: each is unique per
 * session id and has its own ceiling in the helper-return module. The needs_input
 * notification is written by the caller before this runs, so a blocked mention
 * is still visible to the agent.
 */
export async function evaluateAgentMentionGuards(
	db: Database,
	ctx: {
		workspaceId: string
		commentEventId: number
		commenterId: string
		mentionedActorId: string
		objectId: string
		content: string
		isHelperReturn: boolean
	},
): Promise<MentionGuardDecision> {
	const decide = async (decision: MentionGuardDecision): Promise<MentionGuardDecision> => {
		await trackMentionGuardDecision({
			workspaceId: ctx.workspaceId,
			targetActorId: ctx.mentionedActorId,
			objectId: ctx.objectId,
			result: decision.allowed ? 'allowed' : 'blocked',
			reason: decision.allowed ? 'ok' : decision.reason,
			sourceCommentEventId: ctx.commentEventId,
		})
		return decision
	}

	if (ctx.isHelperReturn) return decide({ allowed: true })

	if (await isDuplicateMention(db, ctx)) {
		return decide({ allowed: false, reason: 'mention_duplicate' })
	}
	if (await isMentionCapped(db, ctx)) {
		return decide({ allowed: false, reason: 'mention_capped' })
	}
	return decide({ allowed: true })
}

/**
 * Count sessions this agent already got on this object from agent-authored
 * mentions inside the window. Counted from the sessions table, so it survives
 * restarts. Helper returns are not counted (they have their own ceiling).
 */
async function isMentionCapped(
	db: Database,
	ctx: { mentionedActorId: string; objectId: string },
): Promise<boolean> {
	const since = new Date(Date.now() - MENTION_GUARD_LIMITS.windowMs)
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(sessions)
		.innerJoin(
			actors,
			sql`${actors.id} = (${sessions.config}->'mention'->>'commenter_actor_id')::uuid`,
		)
		.where(
			and(
				eq(sessions.actorId, ctx.mentionedActorId),
				eq(sessions.initiatedFromObjectId, ctx.objectId),
				sql`${sessions.config}->>'trigger_source' = 'comment_fallback'`,
				sql`coalesce(${sessions.config}->'mention'->>'helper_return', 'false') <> 'true'`,
				eq(actors.type, 'agent'),
				gt(sessions.createdAt, since),
			),
		)
	return (row?.n ?? 0) >= MENTION_GUARD_LIMITS.maxAgentMentionsPerWindow
}

/**
 * True when the same author already mentioned the same actor with the same
 * normalised text on this object inside the window. Reads the author's last
 * few comments on the object, no new table.
 */
async function isDuplicateMention(
	db: Database,
	ctx: {
		commentEventId: number
		commenterId: string
		mentionedActorId: string
		objectId: string
		content: string
	},
): Promise<boolean> {
	const since = new Date(Date.now() - MENTION_GUARD_LIMITS.duplicateWindowMs)
	const prior = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.entityType, 'object'),
				eq(events.entityId, ctx.objectId),
				eq(events.actorId, ctx.commenterId),
				eq(events.action, 'commented'),
				lt(events.id, ctx.commentEventId),
				gt(events.createdAt, since),
			),
		)
		.orderBy(desc(events.id))
		.limit(MENTION_GUARD_LIMITS.duplicateLookback)

	const wanted = normalizeMentionText(ctx.content)
	return prior.some((row) => {
		const data = (row.data ?? {}) as { content?: unknown; mentions?: unknown }
		if (!Array.isArray(data.mentions) || !data.mentions.includes(ctx.mentionedActorId)) {
			return false
		}
		return typeof data.content === 'string' && normalizeMentionText(data.content) === wanted
	})
}

/**
 * A comment's helper_return metadata is just a string any author can write.
 * It only counts when the session it names belongs to the comment's author and
 * has taken its one-shot return claim (helper_returned_at is set). Returns that
 * session's hop depth, which the session woken by the return inherits, or null
 * when the marker is not genuine.
 */
export async function verifyHelperReturn(
	db: Database,
	ctx: { sessionId: string; commenterId: string },
): Promise<{ hopDepth: number } | null> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ctx.sessionId)) {
		return null
	}
	const [row] = await db
		.select({ config: sessions.config })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, ctx.sessionId),
				eq(sessions.actorId, ctx.commenterId),
				sql`${sessions.helperReturnedAt} IS NOT NULL`,
			),
		)
		.limit(1)
	return row ? { hopDepth: readHopDepth(row.config) } : null
}

/** Depth stored in sessions.config.hop_depth; anything unreadable counts as 0. */
export function readHopDepth(config: unknown): number {
	const raw = (config as { hop_depth?: unknown } | null)?.hop_depth
	return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0
}
