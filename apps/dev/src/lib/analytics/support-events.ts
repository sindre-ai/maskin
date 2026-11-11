import type { Database, Transaction } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { and, eq, inArray, or } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Customer reports reach Maskin as an insight with this source. Internal
// feedback is out of scope for the support numbers.
const CUSTOMER_FEEDBACK_SOURCE = 'customer_feedback'
// A fix task is linked to the insight it came from by one of these edges, in
// either direction.
const LINK_TYPES = ['relates_to', 'informs']

function isCustomerFeedback(metadata: unknown): boolean {
	return (metadata as { source?: unknown } | null)?.source === CUSTOMER_FEEDBACK_SOURCE
}

interface SupportItemOpenedProps {
	workspaceId: string
	actorId: string
	objectId: string
	objectType: string
	metadata: unknown
}

/**
 * `support_item_opened` when an insight with source customer_feedback is created.
 * We have no helpdesk: this is the ticket volume. Ids and the source only, never
 * the title or text. Best-effort: never throws, so callers fire it without awaiting.
 */
export async function trackSupportItemOpened(p: SupportItemOpenedProps): Promise<void> {
	if (p.objectType !== 'insight' || !isCustomerFeedback(p.metadata)) return
	try {
		await capturePosthogEvent('support_item_opened', p.actorId, {
			workspace_id: p.workspaceId,
			insight_id: p.objectId,
			source: CUSTOMER_FEEDBACK_SOURCE,
		})
	} catch (err) {
		logger.warn('Failed to emit support_item_opened', { objectId: p.objectId, error: String(err) })
	}
}

interface SupportItemResolvedProps {
	workspaceId: string
	actorId: string
	taskId: string
	/** The task's status before and after this write. */
	fromStatus: string | null
	toStatus: string
	/** When the task reached done, i.e. the time of this write. */
	resolvedAt: Date
}

/**
 * `support_item_resolved` when a task moves into done, once for each customer
 * feedback insight linked to it, with the hours (one decimal) from the insight being
 * created to now. A task that was already done, or is not moving to done, sends
 * nothing; a task reopened and finished again sends again. Ids and hours only.
 * Best-effort: never throws. Await it for the reads; the capture itself is not awaited.
 */
export async function trackSupportItemResolved(
	db: Database | Transaction,
	p: SupportItemResolvedProps,
): Promise<void> {
	if (p.toStatus !== 'done' || p.fromStatus === 'done') return
	try {
		const edges = await db
			.select({ sourceId: relationships.sourceId, targetId: relationships.targetId })
			.from(relationships)
			.where(
				and(
					inArray(relationships.type, LINK_TYPES),
					or(
						and(eq(relationships.sourceId, p.taskId), eq(relationships.targetType, 'object')),
						and(eq(relationships.targetId, p.taskId), eq(relationships.sourceType, 'object')),
					),
				),
			)
		const linkedIds = [
			...new Set(edges.map((e) => (e.sourceId === p.taskId ? e.targetId : e.sourceId))),
		]
		if (linkedIds.length === 0) return

		const insights = await db
			.select({ id: objects.id, createdAt: objects.createdAt, metadata: objects.metadata })
			.from(objects)
			.where(
				and(
					inArray(objects.id, linkedIds),
					eq(objects.workspaceId, p.workspaceId),
					eq(objects.type, 'insight'),
				),
			)

		for (const insight of insights) {
			if (!isCustomerFeedback(insight.metadata) || !insight.createdAt) continue
			// One decimal, so a fix inside the hour does not read as zero.
			const hours =
				Math.round(Math.max(0, p.resolvedAt.getTime() - insight.createdAt.getTime()) / 360_000) / 10
			// Not awaited: the caller may hold a transaction open, and only the reads need it.
			void capturePosthogEvent('support_item_resolved', p.actorId, {
				workspace_id: p.workspaceId,
				insight_id: insight.id,
				task_id: p.taskId,
				source: CUSTOMER_FEEDBACK_SOURCE,
				hours_to_resolve: hours,
			})
		}
	} catch (err) {
		logger.warn('Failed to emit support_item_resolved', { taskId: p.taskId, error: String(err) })
	}
}
