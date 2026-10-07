import { createHmac, randomUUID } from 'node:crypto'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { __resetLinkedInMcpRegistryForTests } from '@maskin/mcp/linkedin'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
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

/**
 * Every webhook delivery, whatever its outcome, produces exactly one structured
 * log line and (when an integration row was resolved) one PostHog event.
 * Real Postgres, real route; only the PostHog call and the commit step are
 * intercepted.
 */

const SECRET = 'wes_test_secret'
const ACCOUNT_ID = 'acc_unipile_obs_01'
const OTHER_SENDER = 'ACoAAExampleSenderProviderId'
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
