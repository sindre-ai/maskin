import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { getIntegrationCredential } from '../../integrations/lookup'
import { TokenManager } from '../../integrations/oauth/token-manager'
import { slackPost } from '../../integrations/providers/slack/client'
import { isSlackBotToken } from '../../integrations/providers/slack/mcp-server'
import { getProvider } from '../../integrations/registry'
import { logger } from '../../logger'

export const SALES_CHANNEL = '#sales'

export interface SalesNotice {
	workspaceId: string
	actorId: string
	contactId: string
	/** Shown in the ping so a human reads a name, not an id. Looked up when absent. */
	contactTitle?: string
	/** Maskin attention scale: 3 transfer failed, 4 warm lead, 5 compliance breach. */
	attention: 3 | 4 | 5
	/** Audit event action, e.g. voice_warm_lead_ping. */
	action: string
	text: string
	data?: Record<string, unknown>
}

export interface SalesNotifier {
	notify(db: Database, notice: SalesNotice): Promise<void>
}

async function postToSlack(db: Database, workspaceId: string, text: string): Promise<boolean> {
	const integration = await getIntegrationCredential(db, workspaceId, 'slack', null)
	if (!integration) return false
	const token = await new TokenManager().getValidToken(db, integration.id, getProvider('slack'))
	// A user token would post as the installing human. Same guard as the Slack MCP server.
	if (!isSlackBotToken(token)) return false
	await slackPost('chat.postMessage', token, { channel: SALES_CHANNEL, text })
	return true
}

/**
 * Pings #sales. The audit event on the contact is written first and always, so the
 * ping is on record even when Slack is not connected or the post fails; Slack
 * delivery is best effort and never throws into the call path.
 */
export const defaultSalesNotifier: SalesNotifier = {
	async notify(db, notice) {
		const title =
			notice.contactTitle ??
			(
				await db
					.select({ title: objects.title })
					.from(objects)
					.where(eq(objects.id, notice.contactId))
					.limit(1)
			)[0]?.title
		const body = title ? `${title}: ${notice.text}` : notice.text
		await recordEvent(db, {
			workspaceId: notice.workspaceId,
			actorId: notice.actorId,
			action: notice.action,
			entityType: 'object',
			entityId: notice.contactId,
			data: {
				attention: notice.attention,
				channel: SALES_CHANNEL,
				text: body,
				...notice.data,
			},
		})
		try {
			const posted = await postToSlack(
				db,
				notice.workspaceId,
				`[Attention ${notice.attention}] ${body}`,
			)
			if (!posted) {
				logger.warn('voice sales ping not posted: no usable Slack integration', {
					contactId: notice.contactId,
					action: notice.action,
				})
			}
		} catch (err) {
			logger.error('voice sales ping failed to post', {
				contactId: notice.contactId,
				action: notice.action,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	},
}
