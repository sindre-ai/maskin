import type { Database } from '@maskin/db'
import { events, actors, integrations, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq, ne, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { PostInstallContext, PreDisconnectContext } from '../../types'

/**
 * Metadata marker on trigger rows seeded by the Slack integration. Removal on
 * disconnect matches this marker only, so user-created Slack triggers are
 * never touched.
 */
export const SLACK_DEFAULT_TRIGGER_MARKER = 'slack-integration-default'

/**
 * The agent every workspace gets from `bootstrapWorkspaceObserver` — the only
 * actor we can rely on existing when an arbitrary workspace connects Slack.
 */
const DEFAULT_TARGET_AGENT_NAME = 'Workspace Observer'

const DEFAULT_TRIGGERS: ReadonlyArray<{ entityType: string; name: string }> = [
	{ entityType: 'slack.direct_message', name: 'Slack: respond to direct messages' },
	{ entityType: 'slack.app_mention', name: 'Slack: respond to mentions' },
]

const DEFAULT_ACTION_PROMPT = `A Slack user messaged the Maskin bot. The triggering event JSON contains the Slack payload: data.event.text is the message, data.event.user the Slack user, data.event.channel the channel, and data.event.thread_ts (or data.event.ts) the thread timestamp.

Handle the request using your Maskin tools, then ALWAYS post your answer back to Slack with the Slack tools: reply in the same channel with thread_ts set to the triggering thread, so the answer lands as a thread reply. That Slack reply is the only output the user sees — never finish without posting it. Keep replies concise and conversational.`

/**
 * Seed the default @mention / DM responder triggers when a workspace connects
 * Slack, so mentions get an agent response out of the box instead of silently
 * accumulating unconsumed events. Runs as part of the provider's postInstall:
 * idempotent across reconnects (marker check) and fail-soft — a workspace
 * without the observer agent skips seeding rather than failing the install.
 */
export async function seedSlackDefaultTriggers(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	try {
		const [observer] = await db
			.select({ id: actors.id })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(
					eq(workspaceMembers.workspaceId, ctx.workspaceId),
					eq(actors.type, 'agent'),
					eq(actors.name, DEFAULT_TARGET_AGENT_NAME),
				),
			)
			.limit(1)
		if (!observer) {
			logger.warn('Slack default triggers: no Workspace Observer agent in workspace; skipping', {
				workspaceId: ctx.workspaceId,
				integrationId: ctx.integrationId,
			})
			return
		}

		// The integration's system actor authored the rows — it exists by the time
		// postInstall runs (the callback persists config before invoking hooks).
		const [integration] = await db
			.select({ config: integrations.config })
			.from(integrations)
			.where(eq(integrations.id, ctx.integrationId))
			.limit(1)
		const systemActorId = (integration?.config as { system_actor_id?: string } | null)
			?.system_actor_id
		if (!systemActorId) {
			logger.warn('Slack default triggers: integration has no system_actor_id; skipping', {
				workspaceId: ctx.workspaceId,
				integrationId: ctx.integrationId,
			})
			return
		}

		const seeded = await db
			.select({ config: triggers.config })
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, ctx.workspaceId),
					sql`${triggers.metadata}->>'seeded_by' = ${SLACK_DEFAULT_TRIGGER_MARKER}`,
				),
			)
		const seededEntityTypes = new Set(
			seeded.map((row) => (row.config as { entity_type?: string } | null)?.entity_type),
		)

		for (const def of DEFAULT_TRIGGERS) {
			if (seededEntityTypes.has(def.entityType)) continue
			const [row] = await db
				.insert(triggers)
				.values({
					workspaceId: ctx.workspaceId,
					name: def.name,
					type: 'event',
					config: { entity_type: def.entityType, action: 'created' },
					actionPrompt: DEFAULT_ACTION_PROMPT,
					targetActorId: observer.id,
					enabled: true,
					createdBy: systemActorId,
					metadata: { seeded_by: SLACK_DEFAULT_TRIGGER_MARKER, integration_id: ctx.integrationId },
				})
				.returning({ id: triggers.id, name: triggers.name, type: triggers.type })
			if (row) {
				await db.insert(events).values({
					workspaceId: ctx.workspaceId,
					actorId: systemActorId,
					action: 'created',
					entityType: 'trigger',
					entityId: row.id,
					data: { trigger_name: row.name, type: row.type, seeded_by: SLACK_DEFAULT_TRIGGER_MARKER },
				})
			}
		}

		logger.info('Slack default triggers seeded', {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			targetActorId: observer.id,
		})
	} catch (err) {
		// Fail-soft: a seeding hiccup must not fail the install — the user can
		// still create triggers by hand.
		logger.warn('Slack default trigger seeding failed; continuing install', {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Remove the seeded triggers when the workspace disconnects Slack — unless
 * another Slack team is still actively connected to the same workspace, in
 * which case its events still need a responder. Matches only rows carrying the
 * seed marker; triggers the user created or customised by hand stay put.
 */
export async function removeSlackDefaultTriggers(ctx: PreDisconnectContext): Promise<void> {
	const db = ctx.db as Database
	try {
		const [otherActive] = await db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, ctx.workspaceId),
					eq(integrations.provider, 'slack'),
					eq(integrations.status, 'active'),
					ne(integrations.id, ctx.integrationId),
				),
			)
			.limit(1)
		if (otherActive) {
			logger.info('Slack default triggers kept: another Slack integration is still active', {
				workspaceId: ctx.workspaceId,
				integrationId: ctx.integrationId,
			})
			return
		}

		// The audit event needs an author; the integration row (still readable —
		// preDisconnect runs before the status flip) carries the system actor.
		const [integration] = await db
			.select({ config: integrations.config })
			.from(integrations)
			.where(eq(integrations.id, ctx.integrationId))
			.limit(1)
		const systemActorId = (integration?.config as { system_actor_id?: string } | null)
			?.system_actor_id

		const removed = await db
			.delete(triggers)
			.where(
				and(
					eq(triggers.workspaceId, ctx.workspaceId),
					sql`${triggers.metadata}->>'seeded_by' = ${SLACK_DEFAULT_TRIGGER_MARKER}`,
				),
			)
			.returning({ id: triggers.id, name: triggers.name, type: triggers.type })

		if (systemActorId) {
			for (const row of removed) {
				await db.insert(events).values({
					workspaceId: ctx.workspaceId,
					actorId: systemActorId,
					action: 'deleted',
					entityType: 'trigger',
					entityId: row.id,
					data: {
						trigger_name: row.name,
						type: row.type,
						seeded_by: SLACK_DEFAULT_TRIGGER_MARKER,
					},
				})
			}
		}

		if (removed.length > 0) {
			logger.info('Slack default triggers removed on disconnect', {
				workspaceId: ctx.workspaceId,
				integrationId: ctx.integrationId,
				removed: removed.length,
			})
		}
	} catch (err) {
		// Fail-soft, same contract as the reap: disconnect always proceeds.
		logger.warn('Slack default trigger removal failed; continuing disconnect', {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
