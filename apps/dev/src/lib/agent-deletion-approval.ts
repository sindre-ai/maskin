import type { Database, Transaction } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
import {
	type CommentDecision,
	type DecisionProseViolation,
	parseCommentDecision,
} from '@maskin/shared'
import { and, desc, eq, gt } from 'drizzle-orm'
import { recordEventReturning } from './events/record-event'
import { isWorkspaceMember } from './workspace-auth'

/**
 * A person's yes to one agent deleting another.
 *
 * An agent asks with a decision card whose option carries `delete_agent: { actor_id }`. A person
 * tapping that option records an approval here, in the same transaction as their reply (the
 * way a draft is approved). Nothing is deleted by the tap: the reply wakes the agent, and its
 * `DELETE /api/actors/:id` is allowed only while a current approval names this agent as the one
 * that asked and the target as the one to delete. Replies from an agent, or sent through MCP
 * where a model holds the person's key, never approve (see `mayApprove` in routes/events.ts).
 */

export const DELETION_APPROVED_ACTION = 'deletion_approved'

/** How long a person's yes stays good. The agent is woken by the reply, so this is generous. */
export const DELETION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

export interface AgentDeletionTap {
	cardEventId: number
	agentId: string
	/** The agent that posted the card, and the only one the approval is for. */
	requestedBy: string
}

/**
 * Checks the `delete_agent` options of a new decision: one agent per card, a real agent of this
 * workspace, not the author, not a system agent. Returns the violations (the card must not be
 * posted), or none.
 */
export async function findAgentDeletionViolations(
	db: Database,
	params: { workspaceId: string; authorId: string; decision: CommentDecision },
): Promise<DecisionProseViolation[]> {
	const actions = params.decision.options.flatMap((option, index) =>
		option.delete_agent ? [{ index, agentId: option.delete_agent.actor_id }] : [],
	)
	if (actions.length === 0) return []

	const path = (index: number) => `options.${index}.delete_agent.actor_id`
	const first = actions[0] as (typeof actions)[number]
	if (actions.some((a) => a.agentId !== first.agentId)) {
		return [
			{
				path: 'options',
				message:
					'Every delete_agent option on one card must name the same agent. Use one card per agent.',
			},
		]
	}

	if (first.agentId === params.authorId) {
		return [{ path: path(first.index), message: 'An agent cannot ask to delete itself.' }]
	}

	const [target] = await db
		.select({ type: actors.type, isSystem: actors.isSystem })
		.from(actors)
		.where(eq(actors.id, first.agentId))
		.limit(1)
	if (!target || !(await isWorkspaceMember(db, first.agentId, params.workspaceId))) {
		return [{ path: path(first.index), message: `No agent ${first.agentId} in this workspace.` }]
	}
	if (target.type !== 'agent') {
		return [{ path: path(first.index), message: 'Only agents can be deleted, not people.' }]
	}
	if (target.isSystem) {
		return [{ path: path(first.index), message: 'System agents cannot be deleted.' }]
	}
	return []
}

/** The `delete_agent` option a person's reply picked on a card, if it picked one. */
export async function resolveAgentDeletionTap(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<AgentDeletionTap | null> {
	if (params.parentEventId === undefined) return null
	const reply = params.content.trim()
	if (!reply) return null

	const [card] = await db
		.select({ id: events.id, actorId: events.actorId, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, params.parentEventId),
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityId, params.entityId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const decision = parseCommentDecision((card?.data as { decision?: unknown } | null)?.decision)
	if (!card || !decision) return null

	const picked = decision.options.filter((o) => o.label.trim() === reply)
	const agentId = picked.length === 1 ? picked[0]?.delete_agent?.actor_id : undefined
	if (!agentId) return null
	return { cardEventId: Number(card.id), agentId, requestedBy: card.actorId }
}

export async function recordAgentDeletionApproval(
	tx: Transaction,
	params: { workspaceId: string; approverId: string; tap: AgentDeletionTap },
) {
	return recordEventReturning(tx, {
		workspaceId: params.workspaceId,
		actorId: params.approverId,
		action: DELETION_APPROVED_ACTION,
		entityType: 'actor',
		entityId: params.tap.agentId,
		data: { requested_by: params.tap.requestedBy, reply_to_event_id: params.tap.cardEventId },
	})
}

/** Whether a person has said yes, within the last day, to this agent deleting that one. */
export async function hasAgentDeletionApproval(
	db: Database,
	params: { workspaceId: string; agentId: string; requestedBy: string },
): Promise<boolean> {
	const since = new Date(Date.now() - DELETION_APPROVAL_TTL_MS)
	const rows = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, params.workspaceId),
				eq(events.entityType, 'actor'),
				eq(events.entityId, params.agentId),
				eq(events.action, DELETION_APPROVED_ACTION),
				gt(events.createdAt, since),
			),
		)
		.orderBy(desc(events.id))
		.limit(20)
	return rows.some(
		(r) => (r.data as { requested_by?: string } | null)?.requested_by === params.requestedBy,
	)
}
