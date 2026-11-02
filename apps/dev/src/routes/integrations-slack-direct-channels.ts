import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createApiError } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	DIRECT_POST_CHANNELS_CONFIG_KEY,
	SLACK_CHANNEL_ID_PATTERN,
	directPostChannelsFromConfig,
} from '../lib/integrations/providers/slack/send-object'
import type { IntegrationConfig } from '../lib/types'
import { isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

const bodySchema = z.object({
	channels: z.array(z.string().regex(SLACK_CHANNEL_ID_PATTERN)).max(50),
})

/**
 * PUT /api/integrations/slack/direct-post-channels
 *
 * Replaces the list of Slack channels that agents may post to without a person approving a
 * draft (`config.slack_direct_post_channels` on the workspace's Slack integration). Every
 * other direct post is held. Human admins and owners only: any writer, agents included, can
 * edit an integration, and an agent that could edit this list could allow its own channel and
 * skip the approval. Plain Hono, not createRoute, so the OpenAPI snapshot behind the Apple
 * client does not change.
 */
app.put('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}

	if (!(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only a human admin or owner can change which Slack channels accept direct posts',
			),
			403,
		)
	}

	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}
	const parsed = bodySchema.safeParse(raw)
	if (!parsed.success) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				'channels must be a list of Slack channel ids such as C0123456789 (names and DM ids are not allowed)',
			),
			400,
		)
	}
	const channels = [...new Set(parsed.data.channels)]

	const [existing] = await db
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
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Slack is not connected in this workspace'), 404)
	}

	const before = directPostChannelsFromConfig(existing.config)
	const nextConfig: IntegrationConfig = {
		...((existing.config as IntegrationConfig | null) ?? {}),
		[DIRECT_POST_CHANNELS_CONFIG_KEY]: channels,
	}

	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({ config: nextConfig, updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: existing.id,
			data: { [DIRECT_POST_CHANNELS_CONFIG_KEY]: { before: before ?? null, after: channels } },
		})
	})

	return c.json({ integration_id: existing.id, channels })
})

export default app
