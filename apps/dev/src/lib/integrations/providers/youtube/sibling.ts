import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, inArray, ne } from 'drizzle-orm'

/**
 * True when another workspace still uses the same Google account for YouTube (an active or
 * pending row with the same externalId, which resolve-id fills with the Google email). Revoking
 * the grant then would kill that workspace's refresh token too.
 */
export async function hasSiblingYoutubeGrant(
	db: Database,
	target: { workspaceId: string; externalId: string },
): Promise<boolean> {
	const rows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'youtube'),
				eq(integrations.externalId, target.externalId),
				ne(integrations.workspaceId, target.workspaceId),
				inArray(integrations.status, ['active', 'pending']),
			),
		)
		.limit(1)
	return rows.length > 0
}
