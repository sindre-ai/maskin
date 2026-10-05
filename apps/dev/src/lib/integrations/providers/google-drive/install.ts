import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { PostInstallContext } from '../../types'
import { resolveGooglePeopleId } from '../_google/userinfo'

/**
 * postInstall: store the Google People id on the row as config.drive.peopleId.
 * That is the only thing this task writes; the folder-watch task adds the
 * channel fields next to it. Merged with jsonb_set so config keys the OAuth
 * callback already wrote (system_actor_id, ...) survive.
 *
 * A failure here throws, so the generic callback flips the row to `error` and
 * redirects with post_install_failed rather than leaving a half-set-up row.
 */
export async function setupDriveInstall(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) throw new Error('Google Drive postInstall: no access token in credentials')

	const peopleId = await resolveGooglePeopleId(accessToken)
	const driveSubobject = JSON.stringify({ peopleId })
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{drive}', COALESCE(${integrations.config}->'drive', '{}'::jsonb) || ${driveSubobject}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, ctx.integrationId))
	logger.info('Google Drive peopleId stored', { integrationId: ctx.integrationId })
}
