import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import {
	type CoolifyWebhookPayload,
	buildInsightForPayload,
	verifyCoolifySignature,
} from '../lib/integrations/providers/coolify/webhooks'
import { logger } from '../lib/logger'

type Env = {
	Variables: {
		db: Database
	}
}

const SIGNATURE_HEADER = 'x-coolify-signature'

/**
 * Reads the runtime feature flag fresh on every request — the flag exists so
 * we can kill bad signal-to-noise without redeploying, and a cached read would
 * keep the bad path live until the next process restart.
 */
function isEnabled(): boolean {
	const raw = process.env.COOLIFY_OBSERVABILITY_ENABLED
	if (!raw) return false
	return raw === '1' || raw.toLowerCase() === 'true'
}

const app = new OpenAPIHono<Env>()

app.post('/', async (c) => {
	const db = c.get('db')

	if (!isEnabled()) {
		// Ack so Coolify doesn't retry while the flag is off — we'd rather drop a
		// signal than turn off the flag and keep getting paged by retries.
		logger.info('Coolify webhook received but observability is disabled — skipping')
		return c.json({ ok: true, skipped: 'disabled' })
	}

	const secret = process.env.COOLIFY_WEBHOOK_SECRET
	if (!secret) {
		logger.error('Coolify webhook hit but COOLIFY_WEBHOOK_SECRET is not configured')
		return c.json(createApiError('INTERNAL_ERROR', 'Webhook secret not configured'), 500)
	}

	const body = await c.req.text()
	const signature = c.req.header(SIGNATURE_HEADER) ?? ''
	if (!verifyCoolifySignature(body, signature, secret)) {
		logger.warn('Coolify webhook signature verification failed')
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	let payload: CoolifyWebhookPayload
	try {
		payload = JSON.parse(body) as CoolifyWebhookPayload
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON payload'), 400)
	}

	if (
		payload.event !== 'deployment.failed' &&
		payload.event !== 'application.crashed' &&
		payload.event !== 'application.health_check_failed'
	) {
		// Coolify sends many event types — we only act on the three observability ones.
		return c.json({ ok: true, skipped: 'unhandled_event' })
	}

	const built = buildInsightForPayload(payload)

	// Fan out one insight per active Coolify integration. Multiple Maskin workspaces
	// can share a single Coolify install (e.g. dev + prod workspaces both watching the
	// same staging cluster), so each one needs its own insight.
	const activeIntegrations = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.provider, 'coolify'), eq(integrations.status, 'active')))

	if (activeIntegrations.length === 0) {
		logger.info('Coolify webhook received but no active integration is connected', {
			event: payload.event,
		})
		return c.json({ ok: true, skipped: 'no_integration' })
	}

	let created = 0
	let updated = 0
	const receivedAt = new Date()

	for (const integration of activeIntegrations) {
		try {
			// Heartbeat for AC-T7's watchdog. Updating before insight create/update so
			// even a downstream-write failure leaves a trace that Coolify is reachable —
			// the silence watchdog measures "did Coolify send us anything", not "did
			// we successfully process it".
			const existingConfig = (integration.config as Record<string, unknown> | null) ?? {}
			await db
				.update(integrations)
				.set({
					config: { ...existingConfig, last_event_at: receivedAt.toISOString() },
					updatedAt: receivedAt,
				})
				.where(eq(integrations.id, integration.id))
			// AC-T5 dedup: look up an existing insight on this workspace with the
			// matching fingerprint and bump its occurrence count instead of inserting
			// a new row. Window the lookup so a year-old, long-resolved incident
			// doesn't get reopened by a coincidental fingerprint collision.
			const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
			const [existing] = await db
				.select()
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, integration.workspaceId),
						eq(objects.type, 'insight'),
						sql`metadata->>'fingerprint' = ${built.fingerprint}`,
						sql`created_at >= ${cutoff.toISOString()}`,
					),
				)
				.limit(1)

			if (existing) {
				const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {}
				const occurrence = Number(existingMeta.occurrence_count ?? 1) + 1
				const nextMeta = {
					...existingMeta,
					occurrence_count: occurrence,
					last_seen_at: new Date().toISOString(),
					last_context: built.context,
				}
				await db
					.update(objects)
					.set({ metadata: nextMeta, updatedAt: new Date() })
					.where(eq(objects.id, existing.id))
				await db.insert(events).values({
					workspaceId: integration.workspaceId,
					actorId: integration.createdBy,
					action: 'updated',
					entityType: 'object',
					entityId: existing.id,
					data: {
						source: built.source,
						fingerprint: built.fingerprint,
						occurrence_count: occurrence,
					},
				})
				logger.info('Coolify insight deduped — incremented occurrence count', {
					workspaceId: integration.workspaceId,
					insightId: existing.id,
					source: built.source,
					occurrence,
				})
				updated += 1
				continue
			}

			const [row] = await db
				.insert(objects)
				.values({
					workspaceId: integration.workspaceId,
					type: 'insight',
					title: built.title,
					content: built.content,
					status: 'new',
					createdBy: integration.createdBy,
					metadata: {
						urgent: true,
						source: built.source,
						fingerprint: built.fingerprint,
						integration_id: integration.id,
						received_at: new Date().toISOString(),
						context: built.context,
						occurrence_count: 1,
					},
				})
				.returning({ id: objects.id })

			if (row) {
				await db.insert(events).values({
					workspaceId: integration.workspaceId,
					actorId: integration.createdBy,
					action: 'created',
					entityType: 'object',
					entityId: row.id,
					data: { source: built.source, fingerprint: built.fingerprint, urgent: true },
				})
				logger.info('Coolify insight created', {
					workspaceId: integration.workspaceId,
					insightId: row.id,
					source: built.source,
					fingerprint: built.fingerprint,
				})
				created += 1
			}
		} catch (err) {
			// Per-integration isolation: one workspace failing must not starve the rest.
			logger.error('Coolify insight write failed for integration', {
				workspaceId: integration.workspaceId,
				integrationId: integration.id,
				event: payload.event,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return c.json({ ok: true, created, updated, workspaces: activeIntegrations.length })
})

export default app
