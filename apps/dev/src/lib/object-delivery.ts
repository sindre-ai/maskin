import type { Database } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
import type { ObjectPreview } from '@maskin/shared'
import { and, desc, eq } from 'drizzle-orm'

/**
 * Where a draft stands, read from the object's own `events` log, so nothing about it is
 * stored twice and an edit un-approves by itself.
 *
 *   approved   a person (never an agent) approved exactly this content hash. The newest
 *              such event wins, so approving again after an edit replaces the old one.
 *   delivered  an integration sent exactly this content hash.
 *
 * Both events carry `data.content_hash`. A change to the recipients, subject or text
 * changes the hash, which is why an approval needs no "was it edited since?" scan.
 */

export const APPROVED_ACTION = 'approved'
export const DELIVERED_ACTION = 'delivered'

export interface ObjectApproval {
	/** The id of the approval event. Send claims are keyed on it: one approval, one send. */
	id: number
	actorId: string | null
	createdAt: Date | null
}

async function latestEvent(
	db: Database,
	workspaceId: string,
	objectId: string,
	action: string,
	humanOnly: boolean,
) {
	const rows = await db
		.select({
			id: events.id,
			actorId: events.actorId,
			createdAt: events.createdAt,
			hash: events.data,
		})
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, objectId),
				eq(events.action, action),
				...(humanOnly ? [eq(actors.type, 'human')] : []),
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	const row = rows[0]
	if (!row) return null
	const data = (row.hash ?? {}) as { content_hash?: unknown }
	return {
		id: Number(row.id),
		actorId: row.actorId,
		createdAt: row.createdAt,
		contentHash: typeof data.content_hash === 'string' ? data.content_hash : null,
	}
}

/** The person's approval of exactly this content, or null when there is none. */
export async function findCurrentApproval(
	db: Database,
	workspaceId: string,
	objectId: string,
	contentHash: string,
): Promise<ObjectApproval | null> {
	const latest = await latestEvent(db, workspaceId, objectId, APPROVED_ACTION, true)
	if (!latest || latest.contentHash !== contentHash) return null
	return { id: latest.id, actorId: latest.actorId, createdAt: latest.createdAt }
}

/** Adds `delivery` to a preview: draft, approved, or sent. */
export async function withDeliveryState(
	db: Database,
	workspaceId: string,
	objectId: string,
	preview: ObjectPreview,
): Promise<ObjectPreview> {
	const delivered = await latestEvent(db, workspaceId, objectId, DELIVERED_ACTION, false)
	if (delivered?.contentHash === preview.content_hash) {
		return {
			...preview,
			delivery: { state: 'sent', at: delivered.createdAt?.toISOString() ?? null },
		}
	}
	const approval = await findCurrentApproval(db, workspaceId, objectId, preview.content_hash)
	return {
		...preview,
		delivery: approval
			? { state: 'approved', at: approval.createdAt?.toISOString() ?? null }
			: { state: 'draft', at: null },
	}
}
