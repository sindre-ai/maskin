import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import {
	captureObservabilityInsightCreated,
	captureObservabilitySignalReceived,
	newSignalId,
} from '../lib/analytics/observability-events'
import { createApiError } from '../lib/errors'
import {
	type PosthogWebhookPayload,
	buildInsightForEvent,
	extractExceptionEvent,
	verifyPosthogSignature,
} from '../lib/integrations/providers/posthog/webhooks'
import { logger } from '../lib/logger'

type Env = {
	Variables: {
		db: Database
	}
}

const SIGNATURE_HEADER = 'x-posthog-signature'

/**
 * Reads the runtime feature flag fresh on every request — the flag exists so
 * we can kill bad signal-to-noise without redeploying, and a cached read would
 * keep the bad path live until the next process restart.
 */
function isEnabled(): boolean {
	const raw = process.env.POSTHOG_OBSERVABILITY_ENABLED
	if (!raw) return false
	return raw === '1' || raw.toLowerCase() === 'true'
}

const app = new OpenAPIHono<Env>()

app.post('/', async (c) => {
	const db = c.get('db')

	if (!isEnabled()) {
		// Ack so PostHog doesn't retry while the flag is off — we'd rather drop a
		// signal than turn off the flag and keep getting paged by retries.
		logger.info('PostHog webhook received but observability is disabled — skipping')
		return c.json({ ok: true, skipped: 'disabled' })
	}

	const secret = process.env.POSTHOG_WEBHOOK_SECRET
	if (!secret) {
		logger.error('PostHog webhook hit but POSTHOG_WEBHOOK_SECRET is not configured')
		return c.json(createApiError('INTERNAL_ERROR', 'Webhook secret not configured'), 500)
	}

	const body = await c.req.text()
	const signature = c.req.header(SIGNATURE_HEADER) ?? ''
	if (!verifyPosthogSignature(body, signature, secret)) {
		logger.warn('PostHog webhook signature verification failed')
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	let payload: PosthogWebhookPayload
	try {
		payload = JSON.parse(body) as PosthogWebhookPayload
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON payload'), 400)
	}

	const exceptionEvent = extractExceptionEvent(payload)
	if (!exceptionEvent) {
		// PostHog Actions can be reused for many event types — we only act on $exception.
		return c.json({ ok: true, skipped: 'unhandled_event' })
	}

	const built = buildInsightForEvent(exceptionEvent, { siteUrl: payload.site_url })

	// Fan out one insight per active PostHog integration. Multiple Maskin
	// workspaces can share a single PostHog project (e.g. dev + prod watching
	// the same web app), so each one needs its own insight.
	const activeIntegrations = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.provider, 'posthog'), eq(integrations.status, 'active')))

	if (activeIntegrations.length === 0) {
		logger.info('PostHog webhook received but no active integration is connected', {
			fingerprint: built.fingerprint,
		})
		return c.json({ ok: true, skipped: 'no_integration' })
	}

	let created = 0
	let updated = 0
	const receivedAt = new Date()
	const signalId = newSignalId()

	// is_new_fingerprint = no live insight for this fingerprint across any active
	// integration in the 14d window. The bet's HogQL filters
	// is_new_fingerprint=true on the denominator so AC-T5 dedupe occurrences are
	// excluded — a single PostHog $exception across N workspaces that have all
	// already seen it must register as a NOT-new-fingerprint signal.
	const isNewFingerprintCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
	const [livePriorInsight] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.type, 'insight'),
				sql`metadata->>'fingerprint' = ${built.fingerprint}`,
				sql`created_at >= ${isNewFingerprintCutoff.toISOString()}`,
			),
		)
		.limit(1)
	const isNewFingerprint = !livePriorInsight

	// Fire-and-forget — `capturePosthogEvent` swallows its own errors so a PostHog
	// outage cannot break webhook processing. We don't await here because the bet
	// metric tolerates a small queue delay, and the route stays snappy.
	void captureObservabilitySignalReceived({
		signalId,
		source: 'posthog_exception',
		receivedAt,
		fingerprint: built.fingerprint,
		isNewFingerprint,
	})

	for (const integration of activeIntegrations) {
		try {
			// AC-T5 dedup: look up an existing insight on this workspace with the
			// matching fingerprint and bump its occurrence count instead of
			// inserting a new row. Window the lookup so a long-resolved issue
			// doesn't get reopened by a coincidental fingerprint collision —
			// PostHog can re-emit an issue weeks after the last sighting.
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
					last_seen_at: receivedAt.toISOString(),
					last_context: built.context,
				}
				await db
					.update(objects)
					.set({ metadata: nextMeta, updatedAt: receivedAt })
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
				logger.info('PostHog insight deduped — incremented occurrence count', {
					workspaceId: integration.workspaceId,
					insightId: existing.id,
					source: built.source,
					occurrence,
				})
				void captureObservabilityInsightCreated({
					workspaceId: integration.workspaceId,
					signalId,
					source: 'posthog_exception',
					insightId: existing.id,
					timeToInsightMs: Date.now() - receivedAt.getTime(),
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
						received_at: receivedAt.toISOString(),
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
				logger.info('PostHog insight created', {
					workspaceId: integration.workspaceId,
					insightId: row.id,
					source: built.source,
					fingerprint: built.fingerprint,
				})
				void captureObservabilityInsightCreated({
					workspaceId: integration.workspaceId,
					signalId,
					source: 'posthog_exception',
					insightId: row.id,
					timeToInsightMs: Date.now() - receivedAt.getTime(),
				})
				created += 1
			}
		} catch (err) {
			// Per-integration isolation: one workspace failing must not starve the rest.
			logger.error('PostHog insight write failed for integration', {
				workspaceId: integration.workspaceId,
				integrationId: integration.id,
				fingerprint: built.fingerprint,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return c.json({ ok: true, created, updated, workspaces: activeIntegrations.length })
})

export default app
