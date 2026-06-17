import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../../../crypto'
import { logger } from '../../../logger'
import type { StoredCredentials } from '../../types'
import { isSlackBotToken } from './mcp-server'

export interface ResolvedSlackBotToken {
	botToken: string
	slackTeamId: string | undefined
	integrationId: string
}

/**
 * Resolve the bot token for a workspace's active Slack integration. Returns
 * null when there is no active integration or the stored credential is not a
 * bot token (xoxb-…) — the guard prevents posting as a user when an OAuth
 * scope drift left an xoxp- token in the row.
 */
export async function resolveSlackBotToken(
	db: Database,
	workspaceId: string,
): Promise<ResolvedSlackBotToken | null> {
	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'slack'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) return null

	let credentials: StoredCredentials
	try {
		credentials = JSON.parse(decrypt(integration.credentials as string)) as StoredCredentials
	} catch (err) {
		logger.error('Failed to decrypt Slack credentials', {
			workspaceId,
			integrationId: integration.id,
			error: String(err),
		})
		return null
	}

	const accessToken = credentials.accessToken
	if (!isSlackBotToken(accessToken)) {
		logger.warn('Refusing to post to Slack with a non-bot token', {
			workspaceId,
			integrationId: integration.id,
			tokenPrefix: typeof accessToken === 'string' ? accessToken.slice(0, 5) : 'missing',
		})
		return null
	}

	return {
		botToken: accessToken as string,
		slackTeamId: integration.externalId ?? undefined,
		integrationId: integration.id,
	}
}
