import type { Database } from '@maskin/db'
import { integrations, webhookDeliveries } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError } from '../../../errors'
import { logger } from '../../../logger'
import { verifyChannelToken } from './channel-token'
import type { DriveClient } from './client'
import { runDriveFanOut } from './fan-out'
import { GOOGLE_DRIVE_PROVIDER } from './token'

export interface DriveWebhookResponse {
	status: 200 | 400 | 401 | 500
	body: unknown
}

/**
 * Handle one Drive push notification. Drive delivers an empty body; everything
 * lives in the X-Goog-* headers (keys lowercased by the caller).
 *
 * Order matters:
 *  1. The token check comes first and needs no database: it is the HMAC of the
 *     channel id, compared in constant time. An unsigned or forged call never
 *     reaches the row lookup.
 *  2. The row is found by config.drive.channelId with status active. That join is
 *     the isolation boundary: the channel id is a UUID we minted per row, so a
 *     delivery can only ever resolve to the one row that owns it (never by Google
 *     account email, which two workspaces can share).
 *  3. Dedup on channelId:messageNumber through the webhook_deliveries ledger,
 *     claimed before the fan-out so a retry short-circuits.
 *  4. The sync handshake Google sends when a channel opens is acknowledged and
 *     dropped, with no row lookup, no claim and no log line.
 *
 * A failed fan-out releases the claim and answers 500, so Google's retry
 * reprocesses; pages already committed are not redone because the cursor moved.
 */
export async function processDriveWebhook(
	db: Database,
	headers: Record<string, string>,
	opts: { client?: DriveClient } = {},
): Promise<DriveWebhookResponse> {
	const channelId = headers['x-goog-channel-id']
	const token = headers['x-goog-channel-token']
	if (!channelId || !token) {
		return { status: 400, body: createApiError('BAD_REQUEST', 'Missing channel headers') }
	}
	if (!verifyChannelToken(channelId, token)) {
		logger.warn('Google Drive webhook token verification failed')
		return { status: 401, body: createApiError('UNAUTHORIZED', 'Invalid webhook signature') }
	}
	if (headers['x-goog-resource-state'] === 'sync') {
		return { status: 200, body: { ok: true, skipped: true } }
	}

	const messageNumber = headers['x-goog-message-number']
	if (!messageNumber) {
		return { status: 400, body: createApiError('BAD_REQUEST', 'Missing message number') }
	}

	const [row] = await db
		.select({ id: integrations.id, workspaceId: integrations.workspaceId })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, GOOGLE_DRIVE_PROVIDER),
				eq(integrations.status, 'active'),
				sql`${integrations.config}->'drive'->>'channelId' = ${channelId}`,
			),
		)
		.limit(1)
	if (!row) {
		// Channel of a disconnected or rotated row, still delivering until it expires.
		logger.info('Google Drive webhook for a channel with no active row', { channelId })
		return { status: 200, body: { ok: true, skipped: true } }
	}

	const deliveryId = `${channelId}:${messageNumber}`
	const claimed = await db
		.insert(webhookDeliveries)
		.values({
			provider: GOOGLE_DRIVE_PROVIDER,
			externalId: deliveryId,
			workspaceId: row.workspaceId,
		})
		.onConflictDoNothing({
			target: [
				webhookDeliveries.provider,
				webhookDeliveries.externalId,
				webhookDeliveries.workspaceId,
			],
		})
		.returning({ id: webhookDeliveries.id })
	const claimRowId = claimed[0]?.id
	if (!claimRowId) {
		logger.info('Skipping duplicate google-drive delivery', { deliveryId })
		return { status: 200, body: { ok: true, duplicate: true } }
	}

	try {
		const result = await runDriveFanOut(db, row.id, opts)
		await db
			.update(webhookDeliveries)
			.set({ processedAt: new Date() })
			.where(eq(webhookDeliveries.id, claimRowId))
		return { status: 200, body: { ok: true, emitted: result.emitted } }
	} catch (err) {
		logger.error('Google Drive fan-out failed', {
			integrationId: row.id,
			workspaceId: row.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		await db
			.delete(webhookDeliveries)
			.where(eq(webhookDeliveries.id, claimRowId))
			.catch((releaseErr) => {
				logger.error('Failed to release google-drive delivery claim', {
					deliveryId,
					error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
				})
			})
		return { status: 500, body: createApiError('INTERNAL_ERROR', 'Failed to process webhook') }
	}
}
