import { createHmac, randomUUID } from 'node:crypto'
import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	integrations,
	webhookDeliveries,
} from '@maskin/db/schema'
import {
	__resetLinkedInMcpRegistryForTests,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { recordEvents } from '../../lib/events/record-event'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { commitWebhookDelivery } from '../../lib/integrations/webhooks/commit'
import { logger } from '../../lib/logger'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn(async () => {}) }))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

// Lets one test make the commit step fail after the claims were taken, with
// every other test running the real implementation.
vi.mock('../../lib/integrations/webhooks/commit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/integrations/webhooks/commit')>()
	return { ...actual, commitWebhookDelivery: vi.fn(actual.commitWebhookDelivery) }
})

// Lets one test make the direction-drop write fail, with every other call real.
vi.mock('../../lib/events/record-event', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/events/record-event')>()
	return { ...actual, recordEvents: vi.fn(actual.recordEvents) }
})

/**
 * Every webhook delivery, whatever its outcome, produces exactly one structured
 * log line and (when an integration row was resolved) one PostHog event.
 * Real Postgres, real route; only the PostHog call and the commit step are
 * intercepted.
 */

const SECRET = 'wes_test_secret'
const ACCOUNT_ID = 'acc_unipile_obs_01'
const OTHER_SENDER = 'ACoAAExampleSenderProviderId'
const OWN_SENDER = 'ACoAAExampleOwnProviderId'
const FLAG = 'linkedin-unipile-events'
const LINE = 'linkedin-unipile webhook: delivery'

const ENV_KEYS = [
	'UNIPILE_WEBHOOK_SECRET',
	'INTEGRATION_ENCRYPTION_KEY',
	'FF_TESTER_ACTOR_IDS',
	'FF_TESTER_FEATURES',
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

let app: ReturnType<typeof createIntegrationApp>
let workspaceId: string
let ownerActorId: string
let integrationId: string

const spies = {
	info: vi.spyOn(logger, 'info'),
	warn: vi.spyOn(logger, 'warn'),
	error: vi.spyOn(logger, 'error'),
}

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	const routes = (await import('../../routes/integrations-linkedin-unipile')).default
	app = createIntegrationApp({ path: '/api/integrations/linkedin-unipile', module: routes })
})

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
		else process.env[key] = ORIGINAL_ENV[key]
	}
	_resetFeatureFlagConfig()
	__resetLinkedInMcpRegistryForTests()
})

async function insertIntegration(workspace: string, actor: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			externalId: ACCOUNT_ID,
			credentials: encrypt(JSON.stringify({ account_id: ACCOUNT_ID })),
			actorId: actor,
			createdBy: actor,
		})
		.returning()
	if (!row) throw new Error('integration insert returned no row')
	return row
}

beforeEach(async () => {
	process.env.UNIPILE_WEBHOOK_SECRET = SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	vi.clearAllMocks()
	__resetLinkedInMcpRegistryForTests()

	const owner = await insertActor(db)
	ownerActorId = owner.id
	const ws = await insertWorkspace(db, getTestActorId())
	workspaceId = ws.id
	integrationId = (await insertIntegration(workspaceId, ownerActorId)).id

	process.env.FF_TESTER_ACTOR_IDS = ownerActorId
	process.env.FF_TESTER_FEATURES = FLAG
	_resetFeatureFlagConfig()
})

function messageNew(
	overrides: { envelopeId?: string; messageId?: string; message?: Record<string, unknown> } = {},
) {
	return {
		id: overrides.envelopeId ?? `evt_${randomUUID()}`,
		created_at: '2026-10-04T10:15:30.000Z',
		account_id: ACCOUNT_ID,
		type: 'message.new',
		payload: {
			id: overrides.messageId ?? `msg_${randomUUID()}`,
			chat_id: 'chat_1',
			timestamp: '2026-10-04T10:15:29.000Z',
			sender_id: OTHER_SENDER,
			is_sender: false,
			text: 'hello, secret message text',
			...overrides.message,
		},
	}
}

function deliver(body: unknown) {
	const rawBody = JSON.stringify(body)
	const tSec = Math.floor(Date.now() / 1000)
	const v0 = createHmac('sha256', SECRET).update(`${tSec}.${rawBody}`).digest('hex')
	return app.request('/api/integrations/linkedin-unipile/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'unipile-signature': `t=${tSec},v0=${v0}` },
		body: rawBody,
	})
}

/** Every delivery line written so far, across levels. */
function deliveryLines(): Array<Record<string, unknown>> {
	return [...spies.info.mock.calls, ...spies.warn.mock.calls, ...spies.error.mock.calls]
		.filter(([message]) => message === LINE)
		.map(([, fields]) => fields as Record<string, unknown>)
}

function captured() {
	return captureMock.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>
}

describe('one log line and one PostHog event per delivery', () => {
	it('emitted: one line with every field and one unipile_webhook_received', async () => {
		const body = messageNew({ envelopeId: 'evt_obs_emit', messageId: 'msg_obs_emit' })
		expect((await deliver(body)).status).toBe(200)

		const lines = deliveryLines()
		expect(lines).toHaveLength(1)
		expect(lines[0]).toMatchObject({
			event_type: 'message.new',
			integration_id: integrationId,
			account_id: ACCOUNT_ID,
			external_id: 'msg_obs_emit',
			envelope_id: 'evt_obs_emit',
			outcome: 'emitted',
			reason: null,
			classification: null,
			direction_source: 'is_sender',
		})
		expect(typeof lines[0]?.latency_ms).toBe('number')
		expect(JSON.stringify(lines)).not.toContain('secret message text')

		expect(captured()).toHaveLength(1)
		expect(captured()[0]).toEqual([
			'unipile_webhook_received',
			workspaceId,
			{
				event_type: 'message.new',
				mapped: true,
				deduped: false,
				outcome: 'emitted',
				reason: null,
				workspace_id: workspaceId,
				account_id: ACCOUNT_ID,
			},
		])
	})

	it('duplicate: a replay adds exactly one more line and one more event, marked deduped', async () => {
		const body = messageNew({ envelopeId: 'evt_obs_dup', messageId: 'msg_obs_dup' })
		await deliver(body)
		await deliver(body)

		const lines = deliveryLines()
		expect(lines.map((l) => l.outcome)).toEqual(['emitted', 'duplicate'])
		expect(lines[1]).toMatchObject({ reason: 'duplicate', direction_source: null })
		expect(captured().map((c) => [c[2].outcome, c[2].deduped])).toEqual([
			['emitted', false],
			['duplicate', true],
		])
	})

	it('dropped: own messages and direction_unknown each log once with their reason', async () => {
		await deliver(messageNew({ message: { is_sender: true } }))
		await deliver(messageNew({ message: { is_sender: undefined } }))

		const lines = deliveryLines()
		expect(lines).toHaveLength(2)
		expect(lines[0]).toMatchObject({
			outcome: 'dropped',
			reason: 'own_message',
			direction_source: 'is_sender',
		})
		expect(lines[1]).toMatchObject({
			outcome: 'dropped',
			reason: 'direction_unknown',
			direction_source: 'sender_id_fallback',
		})
		expect(spies.warn.mock.calls.filter(([m]) => m === LINE)).toHaveLength(1)
		expect(captured().map((c) => [c[2].outcome, c[2].reason])).toEqual([
			['dropped', 'own_message'],
			['dropped', 'direction_unknown'],
		])
	})

	it('dropped: flag off logs and fires once', async () => {
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()
		await deliver(messageNew())

		expect(deliveryLines()).toHaveLength(1)
		expect(deliveryLines()[0]).toMatchObject({ outcome: 'dropped', reason: 'flag_off' })
		expect(captured()).toHaveLength(1)
	})

	it('failed: a commit failure logs one error line and fires once, not twice', async () => {
		vi.mocked(commitWebhookDelivery).mockRejectedValueOnce(
			Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }),
		)
		const res = await deliver(messageNew({ envelopeId: 'evt_obs_fail', messageId: 'msg_obs_fail' }))
		expect(res.status).toBe(503)

		const lines = deliveryLines()
		expect(lines).toHaveLength(1)
		expect(lines[0]).toMatchObject({
			outcome: 'failed',
			reason: 'ECONNRESET',
			error: 'connection terminated',
			integration_id: integrationId,
			external_id: 'msg_obs_fail',
		})
		expect(spies.error.mock.calls.filter(([m]) => m === LINE)).toHaveLength(1)
		expect(captured()).toHaveLength(1)
		expect(captured()[0]?.[2]).toMatchObject({ outcome: 'failed', reason: 'ECONNRESET' })
	})

	it('failed: a budget timeout reports every unreached integration row once', async () => {
		const secondOwner = await insertActor(db)
		const secondWorkspace = await insertWorkspace(db, getTestActorId())
		const second = await insertIntegration(secondWorkspace.id, secondOwner.id)
		process.env.FF_TESTER_ACTOR_IDS = `${ownerActorId},${secondOwner.id}`
		_resetFeatureFlagConfig()
		vi.mocked(commitWebhookDelivery).mockImplementation(
			() => new Promise((resolve) => setTimeout(resolve, 6000)),
		)

		try {
			const { ingestUnipileEnvelope } = await import(
				'../../lib/integrations/providers/linkedin-unipile/ingest'
			)
			const { readUnipileEnvelope } = await import(
				'../../lib/integrations/providers/linkedin-unipile/envelope'
			)
			const { getEventMapRow } = await import(
				'../../lib/integrations/providers/linkedin-unipile/event-map'
			)
			const envelope = readUnipileEnvelope(messageNew({ messageId: 'msg_obs_budget' }))
			const mapRow = getEventMapRow('message.new')
			if (!mapRow) throw new Error('message.new row missing')
			const outcome = await ingestUnipileEnvelope(db, mapRow, envelope, { budgetMs: 300 })
			expect(outcome.status).toBe(503)
		} finally {
			vi.mocked(commitWebhookDelivery).mockReset()
		}

		const lines = deliveryLines()
		expect(lines.every((l) => l.outcome === 'failed')).toBe(true)
		expect(new Set(lines.map((l) => l.integration_id))).toEqual(new Set([integrationId, second.id]))
		expect(lines).toHaveLength(2)
	})

	it('no active integration and unknown type: one line each, no PostHog event', async () => {
		await deliver({ ...messageNew(), account_id: 'acc_nobody' })
		await deliver({ ...messageNew(), type: 'chat.something_else' })

		const lines = deliveryLines()
		expect(lines).toHaveLength(2)
		expect(lines[0]).toMatchObject({
			outcome: 'dropped',
			reason: 'no_active_integration',
			integration_id: null,
			account_id: 'acc_nobody',
		})
		expect(lines[1]).toMatchObject({
			outcome: 'dropped',
			reason: 'unknown_type',
			event_type: 'chat.something_else',
		})
		expect(captured()).toHaveLength(0)
	})
})

async function webhookRows(action: string) {
	return db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'linkedin.webhook'),
				eq(events.action, action),
			),
		)
}

function registerOwnIdentity() {
	registerLinkedInMcpInstance({
		workspaceId,
		actorId: ownerActorId,
		integrationId,
		unipileAccountId: ACCOUNT_ID,
		unipileAccSlug: 'own-slug',
		identityType: 'personal',
		identityUrn: `urn:li:person:${OWN_SENDER}`,
		identitySlug: 'personal',
		displayName: 'Own Member',
		mailboxId: null,
		messagingEnabled: true,
	})
}

describe('direction drops leave one durable events row (query e)', () => {
	it('direction_unknown: one dropped row with ids only, and the reason reaches the PostHog capture', async () => {
		const body = messageNew({
			envelopeId: 'evt_obs_unknown',
			messageId: 'msg_obs_unknown',
			message: { is_sender: undefined },
		})
		const res = await deliver(body)
		expect(await res.json()).toEqual({ ok: true, skipped: 'direction_unknown' })

		const rows = await webhookRows('dropped')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ entityId: integrationId })
		expect(rows[0]?.data).toEqual({
			reason: 'direction_unknown',
			unipile_event_type: 'message.new',
			external_id: 'msg_obs_unknown',
			envelope_id: 'evt_obs_unknown',
			account_id: ACCOUNT_ID,
		})
		expect(JSON.stringify(rows[0]?.data)).not.toContain('secret message text')

		// Smoke check for the PostHog side: the reason property is on the capture call.
		expect(captured()).toHaveLength(1)
		expect(captured()[0]?.[2]).toMatchObject({ outcome: 'dropped', reason: 'direction_unknown' })
	})

	it('direction_conflict: one dropped row with its reason', async () => {
		registerOwnIdentity()
		const res = await deliver(
			messageNew({
				envelopeId: 'evt_obs_conflict',
				messageId: 'msg_obs_conflict',
				message: { is_sender: false, sender_id: OWN_SENDER },
			}),
		)
		expect(await res.json()).toEqual({ ok: true, skipped: 'direction_conflict' })

		const rows = await webhookRows('dropped')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({
			reason: 'direction_conflict',
			envelope_id: 'evt_obs_conflict',
			external_id: 'msg_obs_conflict',
		})
	})

	it('own_message, flag_off and no_active_integration write no row', async () => {
		await deliver(messageNew({ message: { is_sender: true } }))
		await deliver({ ...messageNew(), account_id: 'acc_nobody' })
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()
		await deliver(messageNew())

		expect(deliveryLines().map((l) => l.reason)).toEqual([
			'own_message',
			'no_active_integration',
			'flag_off',
		])
		expect(await webhookRows('dropped')).toHaveLength(0)
	})

	it('a failed write changes neither the answer, the claims nor the log line', async () => {
		vi.mocked(recordEvents).mockRejectedValueOnce(new Error('events insert failed'))
		const body = messageNew({
			envelopeId: 'evt_obs_guard',
			messageId: 'msg_obs_guard',
			message: { is_sender: undefined },
		})
		const res = await deliver(body)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'direction_unknown' })
		expect(await webhookRows('dropped')).toHaveLength(0)
		expect(spies.error.mock.calls.map(([m]) => m)).toContain(
			'linkedin-unipile webhook: failed to write direction drop event',
		)
		// Claims untouched: still unprocessed, so a retry dedupes instead of reprocessing.
		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, workspaceId))
		expect(claims).toHaveLength(2)
		expect(claims.every((c) => c.processedAt === null)).toBe(true)
		expect(deliveryLines()).toHaveLength(1)
		expect(deliveryLines()[0]).toMatchObject({ outcome: 'dropped', reason: 'direction_unknown' })

		const retry = await deliver(body)
		expect(await retry.json()).toEqual({ ok: true, skipped: 'duplicate' })
	})
})
