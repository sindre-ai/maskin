import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { YoutubeConnectionRef } from './errors'

export const YOUTUBE_PROVIDER = 'youtube'

/**
 * The workspace's active YouTube connections, oldest first. YouTube is workspace-scoped, so each
 * row is one connected Google account (its external id). Only ids and the account label leave
 * here; no credential is read.
 */
export async function listYoutubeConnections(
	db: Database,
	workspaceId: string,
): Promise<YoutubeConnectionRef[]> {
	const rows = await db
		.select({ id: integrations.id, externalId: integrations.externalId })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, YOUTUBE_PROVIDER),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
				isNull(integrations.actorId),
			),
		)
		.orderBy(asc(integrations.createdAt), asc(integrations.id))
	return rows.map((row) => ({ integration_id: row.id, account: row.externalId }))
}
