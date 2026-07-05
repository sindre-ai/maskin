import type { Database } from '@maskin/db'
import { events, workspaceMembers } from '@maskin/db/schema'
import { asc, eq } from 'drizzle-orm'
import { logger } from './logger'

// Profile fields live on `actors` (a global identity row), but `events.workspaceId`
// is NOT NULL. T1 picked the user's earliest workspace as the home for these rows
// until a workspace-independent event surface lands. See PR description for the
// flag and the knowledge article for the long-term plan.
async function earliestWorkspaceFor(db: Database, actorId: string): Promise<string | null> {
	const [row] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorId))
		.orderBy(asc(workspaceMembers.joinedAt))
		.limit(1)
	return row?.workspaceId ?? null
}

export async function emitProfileFieldChanged(
	db: Database,
	actorId: string,
	field: string,
): Promise<void> {
	const workspaceId = await earliestWorkspaceFor(db, actorId)
	if (!workspaceId) {
		// User has no workspaces — telemetry has nowhere to live. Log once so the
		// adoption metric query notices the gap; don't fail the field write.
		logger.warn('profile.field_changed dropped: actor has no workspace', { actorId, field })
		return
	}

	try {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'profile.field_changed',
			entityType: 'actor',
			entityId: actorId,
			data: { field },
		})
		logger.info('profile.field_changed', { actorId, field, workspaceId })
	} catch (err) {
		// Don't bubble — the field write already succeeded. The metric is
		// best-effort; surfacing the failure to the API would be worse than missing
		// one row in the adoption dashboard.
		logger.error('Failed to write profile.field_changed event', {
			actorId,
			field,
			error: String(err),
		})
	}
}
