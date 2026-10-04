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
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { readUnipileEnvelope } from '../../lib/integrations/providers/linkedin-unipile/envelope'
import {
	type EventMapRow,
	getEventMapRow,
} from '../../lib/integrations/providers/linkedin-unipile/event-map'
import { ingestUnipileEnvelope } from '../../lib/integrations/providers/linkedin-unipile/ingest'
import { commitWebhookDelivery } from '../../lib/integrations/webhooks/commit'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

// Lets one test make the commit step fail after the claims were taken, with
// every other test running the real implementation.
vi.mock('../../lib/integrations/webhooks/commit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/integrations/webhooks/commit')>()
	return { ...actual, commitWebhookDelivery: vi.fn(actual.commitWebhookDelivery) }
})

/**
 * Route-level coverage for POST /api/integrations/linkedin-unipile/webhook
 * against real Postgres: signed message.new deliveries become deduped events
 * rows, own sends are dropped, and every permanent condition answers 200.
 *
 * Mocked-DB tests cannot show the claim semantics this depends on (unique
 * index, onConflictDoNothing, transactional rollback), so everything here
 * reads webhook_deliveries and events back from Postgres.
 */

const SECRET = 'wes_test_secret'
const ENCRYPTION_KEY = 'a'.repeat(64)
const ACCOUNT_ID = 'acc_unipile_test_01'
const OWN_SENDER = 'ACoAAOwnMemberProviderId'
const OTHER_SENDER = 'ACoAAExampleSenderProviderId'
const FLAG = 'linkedin-unipile-events'

const ENV_KEYS = [
	'UNIPILE_WEBHOOK_SECRET',
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'INTEGRATION_ENCRYPTION_KEY',
	'FF_TESTER_ACTOR_IDS',
	'FF_TESTER_FEATURES',
	'POSTHOG_API_KEY',
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

let app: ReturnType<typeof createIntegrationApp>
let workspaceId: string
let ownerActorId: string
let integrationId: string

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

async function insertLinkedInIntegration(
	overrides: Partial<typeof integrations.$inferInsert> = {},
): Promise<typeof integrations.$inferSelect> {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			externalId: ACCOUNT_ID,
			credentials: encrypt(JSON.stringify({ account_id: ACCOUNT_ID })),
			actorId: ownerActorId,
			createdBy: ownerActorId,
			...overrides,
		})
		.returning()
	if (!row) throw new Error('integration insert returned no row')
	return row
}

beforeEach(async () => {
	process.env.UNIPILE_WEBHOOK_SECRET = SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.UNIPILE_BASE_URL = 'http://unipile.invalid'
	process.env.UNIPILE_API_KEY = 'test-api-key'
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY

	await sql`TRUNCATE webhook_deliveries`
	__resetLinkedInMcpRegistryForTests()
	vi.mocked(commitWebhookDelivery).mockClear()

	// Distinct account id per test run is unnecessary: the workspace is fresh,
	// and webhook_deliveries is unique per workspace.
	const owner = await insertActor(db)
	ownerActorId = owner.id
	const ws = await insertWorkspace(db, getTestActorId())
	workspaceId = ws.id
	const integration = await insertLinkedInIntegration()
	integrationId = integration.id

	process.env.FF_TESTER_ACTOR_IDS = ownerActorId
	process.env.FF_TESTER_FEATURES = FLAG
	_resetFeatureFlagConfig()
})

// ── Helpers ────────────────────────────────────────────────────────────────

function messageNew(
	overrides: {
		envelopeId?: string
		messageId?: string
		accountId?: string
		message?: Record<string, unknown>
		/** Payload keys to leave out entirely, to model a delivery that lacks them. */
		omit?: string[]
	} = {},
) {
	const message: Record<string, unknown> = {
		id: overrides.messageId ?? 'msg_1',
		chat_id: 'chat_1',
		timestamp: '2026-10-04T10:15:29.000Z',
		sender_id: OTHER_SENDER,
		is_sender: false,
		text: 'hello, secret message text',
		...overrides.message,
	}
	for (const key of overrides.omit ?? []) Reflect.deleteProperty(message, key)
	return {
		id: overrides.envelopeId ?? `evt_${randomUUID()}`,
		created_at: '2026-10-04T10:15:30.000Z',
		account_id: overrides.accountId ?? ACCOUNT_ID,
		account_provider: 'LINKEDIN',
		account_name: 'Test Member',
		type: 'message.new',
		payload: message,
	}
}

function signedHeader(rawBody: string, tSec = Math.floor(Date.now() / 1000)) {
	const v0 = createHmac('sha256', SECRET).update(`${tSec}.${rawBody}`).digest('hex')
	return `t=${tSec},v0=${v0}`
}

function deliver(body: unknown, opts: { rawBody?: string; header?: string } = {}) {
	const rawBody = opts.rawBody ?? JSON.stringify(body)
	return app.request('/api/integrations/linkedin-unipile/webhook', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'unipile-signature': opts.header ?? signedHeader(rawBody),
		},
		body: rawBody,
	})
}

async function messageEvents() {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'linkedin.message')))
}

async function deliveries() {
	return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, workspaceId))
}

function registerOwnIdentity(urn = `urn:li:person:${OWN_SENDER}`) {
	registerLinkedInMcpInstance({
		workspaceId,
		actorId: ownerActorId,
		integrationId,
		unipileAccountId: ACCOUNT_ID,
		unipileAccSlug: 'own-slug',
		identityType: 'personal',
		identityUrn: urn,
		identitySlug: 'personal',
		displayName: 'Own Member',
		mailboxId: null,
		messagingEnabled: true,
	})
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe('POST /webhook: message.new becomes one events row', () => {
	it('writes received_unresolved with ids only and marks both claims processed', async () => {
		const body = messageNew({ envelopeId: 'evt_happy', messageId: 'msg_happy' })
		const res = await deliver(body)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const rows = await messageEvents()
		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row?.action).toBe('received_unresolved')
		expect(row?.entityId).toBe(integrationId)
		// No system_actor_id on the row, so the integration actor is the event actor.
		expect(row?.actorId).toBe(ownerActorId)
		expect(row?.data).toEqual({
			provider: 'linkedin-unipile',
			unipile_event_type: 'message.new',
			integration_id: integrationId,
			unipile_account_id: ACCOUNT_ID,
			external_id: 'msg_happy',
			envelope_id: 'evt_happy',
			provider_timestamp: '2026-10-04T10:15:29.000Z',
			chat_id: 'chat_1',
			message_id: 'msg_happy',
			sender_provider_id: OTHER_SENDER,
			direction: 'inbound',
			direction_source: 'is_sender',
		})
		expect(JSON.stringify(row?.data)).not.toContain('secret message text')

		const claims = await deliveries()
		expect(claims.map((c) => c.externalId).sort()).toEqual(
			[`evt:${ACCOUNT_ID}:evt_happy`, `msg:${ACCOUNT_ID}:msg_happy`].sort(),
		)
		expect(claims.every((c) => c.provider === 'linkedin-unipile')).toBe(true)
		expect(claims.every((c) => c.processedAt !== null)).toBe(true)
	})

	it('attributes the event to config.system_actor_id when the integration has one', async () => {
		const systemActor = await insertActor(db)
		await db
			.update(integrations)
			.set({ config: { system_actor_id: systemActor.id } })
			.where(eq(integrations.id, integrationId))

		const res = await deliver(messageNew())
		expect(res.status).toBe(200)
		expect((await messageEvents())[0]?.actorId).toBe(systemActor.id)
	})

	it('accepts an is_sender sent as 0 and reads it as inbound', async () => {
		const res = await deliver(messageNew({ message: { is_sender: 0 } }))
		expect(await res.json()).toEqual({ ok: true, count: 1 })
	})

	it('verifies raw bodies with odd whitespace and non-ASCII characters', async () => {
		const body = messageNew({ messageId: 'msg_unicode' })
		const rawBody = `{ "id" : "${body.id}",\n\t"created_at":"${body.created_at}" ,"account_id":"${ACCOUNT_ID}", "type":"message.new",\r\n"payload":${JSON.stringify(
			{ ...body.payload, text: 'Hej Jørgen 👋 日本語' },
		)}  }\n`
		const res = await deliver(null, { rawBody })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, count: 1 })
	})
})

// ── Dedupe ─────────────────────────────────────────────────────────────────

describe('POST /webhook: dedupe', () => {
	it('answers a replay of the same payload with 200 skipped duplicate and writes one row', async () => {
		const body = messageNew({ envelopeId: 'evt_replay', messageId: 'msg_replay' })
		expect(await (await deliver(body)).json()).toEqual({ ok: true, count: 1 })

		const replay = await deliver(body)
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await messageEvents()).toHaveLength(1)
		expect(await deliveries()).toHaveLength(2)
	})

	it('treats the same message under a new envelope id as a duplicate and leaves no orphan claim', async () => {
		await deliver(messageNew({ envelopeId: 'evt_a', messageId: 'msg_same' }))
		const second = await deliver(messageNew({ envelopeId: 'evt_b', messageId: 'msg_same' }))

		expect(second.status).toBe(200)
		expect(await second.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await messageEvents()).toHaveLength(1)
		// The new envelope claim rolled back with the duplicate content claim.
		expect((await deliveries()).map((c) => c.externalId)).not.toContain(`evt:${ACCOUNT_ID}:evt_b`)
	})

	it('writes one row for two concurrent identical deliveries', async () => {
		const body = messageNew({ envelopeId: 'evt_race', messageId: 'msg_race' })
		const [a, b] = await Promise.all([deliver(body), deliver(body)])

		const bodies = [await a.json(), await b.json()] as Array<Record<string, unknown>>
		expect(bodies.filter((r) => r.count === 1)).toHaveLength(1)
		expect(bodies.filter((r) => r.skipped === 'duplicate')).toHaveLength(1)
		expect(await messageEvents()).toHaveLength(1)
	})
})

// ── Failure handling ───────────────────────────────────────────────────────

describe('POST /webhook: failure after the claim', () => {
	it('releases the claims, writes a dead-letter row and returns 503; the retry then succeeds', async () => {
		const body = messageNew({ envelopeId: 'evt_fail', messageId: 'msg_fail' })
		vi.mocked(commitWebhookDelivery).mockRejectedValueOnce(
			Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }),
		)

		const res = await deliver(body)
		expect(res.status).toBe(503)
		expect(await messageEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)

		const deadLetters = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'linkedin.webhook')))
		expect(deadLetters).toHaveLength(1)
		expect(deadLetters[0]?.action).toBe('failed')
		expect(deadLetters[0]?.entityId).toBe(integrationId)
		expect(deadLetters[0]?.data).toEqual({
			unipile_event_type: 'message.new',
			external_id: 'msg_fail',
			envelope_id: 'evt_fail',
			error_code: 'ECONNRESET',
		})

		// Unipile's retry reprocesses cleanly because the claims were released.
		const retry = await deliver(body)
		expect(await retry.json()).toEqual({ ok: true, count: 1 })
		expect(await messageEvents()).toHaveLength(1)
	})

	it('releases the claims and answers 503 when the work budget is exceeded', async () => {
		const mapRow = getEventMapRow('message.new')
		if (!mapRow) throw new Error('message.new row missing')
		const slowRow: EventMapRow = { ...mapRow, classify: () => new Promise(() => {}) }
		const envelope = readUnipileEnvelope(
			messageNew({ envelopeId: 'evt_slow', messageId: 'msg_slow' }),
		)

		const outcome = await ingestUnipileEnvelope(db, slowRow, envelope, { budgetMs: 50 })

		expect(outcome.status).toBe(503)
		expect(await deliveries()).toHaveLength(0)
		expect(await messageEvents()).toHaveLength(0)
	})
})

// ── Account resolution and flag ────────────────────────────────────────────

describe('POST /webhook: account resolution and flag', () => {
	it('answers 200 skipped no_active_integration for a revoked integration and writes no row', async () => {
		await db
			.update(integrations)
			.set({ status: 'revoked' })
			.where(eq(integrations.id, integrationId))

		const res = await deliver(messageNew())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'no_active_integration' })
		expect(await messageEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)
	})

	it('answers 200 skipped no_active_integration for an unknown account', async () => {
		const res = await deliver(messageNew({ accountId: 'acc_nobody' }))
		expect(await res.json()).toEqual({ ok: true, skipped: 'no_active_integration' })
	})

	it('answers 200 skipped flag_off with no events row and no claim row when the flag is off', async () => {
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()

		const res = await deliver(messageNew())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'flag_off' })
		expect(await messageEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)
	})

	it('reads the flag on the integration actor, so a different tester does not enable it', async () => {
		process.env.FF_TESTER_ACTOR_IDS = randomUUID()
		_resetFeatureFlagConfig()

		const res = await deliver(messageNew())
		expect(await res.json()).toEqual({ ok: true, skipped: 'flag_off' })
	})

	it('falls back to created_by for the flag when the integration has no actor_id', async () => {
		await db.update(integrations).set({ actorId: null }).where(eq(integrations.id, integrationId))

		const res = await deliver(messageNew())
		expect(await res.json()).toEqual({ ok: true, count: 1 })
		expect((await messageEvents())[0]?.actorId).toBe(ownerActorId)
	})

	it('fans out per integration row when an account is attached to two workspaces', async () => {
		const otherOwner = await insertActor(db)
		const otherWs = await insertWorkspace(db, getTestActorId())
		await db.insert(integrations).values({
			workspaceId: otherWs.id,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			externalId: ACCOUNT_ID,
			credentials: encrypt(JSON.stringify({ account_id: ACCOUNT_ID })),
			actorId: otherOwner.id,
			createdBy: otherOwner.id,
		})
		process.env.FF_TESTER_ACTOR_IDS = `${ownerActorId},${otherOwner.id}`
		_resetFeatureFlagConfig()

		const res = await deliver(messageNew())
		expect(await res.json()).toEqual({ ok: true, count: 2 })
		expect(await messageEvents()).toHaveLength(1)
		const other = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, otherWs.id), eq(events.entityType, 'linkedin.message')))
		expect(other).toHaveLength(1)
	})
})

// ── Direction ──────────────────────────────────────────────────────────────

describe('POST /webhook: direction', () => {
	it('drops is_sender true as own_message and marks the claims processed', async () => {
		const res = await deliver(messageNew({ message: { is_sender: true, sender_id: OWN_SENDER } }))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'own_message' })
		expect(await messageEvents()).toHaveLength(0)
		const claims = await deliveries()
		expect(claims).toHaveLength(2)
		expect(claims.every((c) => c.processedAt !== null)).toBe(true)
	})

	it('drops is_sender false with an own sender id in the registry as direction_conflict', async () => {
		registerOwnIdentity()
		const res = await deliver(messageNew({ message: { is_sender: false, sender_id: OWN_SENDER } }))

		expect(await res.json()).toEqual({ ok: true, skipped: 'direction_conflict' })
		expect(await messageEvents()).toHaveLength(0)
	})

	it('still treats is_sender false from another sender as inbound when the registry is populated', async () => {
		registerOwnIdentity()
		const res = await deliver(messageNew())
		expect(await res.json()).toEqual({ ok: true, count: 1 })
	})

	it('gives direction_unknown and no row when is_sender is absent and the registry is empty; the claim stays', async () => {
		const body = messageNew({ omit: ['is_sender'] })

		const res = await deliver(body)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'direction_unknown' })
		expect(await messageEvents()).toHaveLength(0)
		const claims = await deliveries()
		expect(claims).toHaveLength(2)
		expect(claims.every((c) => c.processedAt === null)).toBe(true)

		// A retry of the same delivery is deduped by the surviving claim.
		const replay = await deliver(body)
		expect(await replay.json()).toEqual({ ok: true, skipped: 'duplicate' })
	})

	it('after a restart (registry cleared) drops an own send on is_sender alone, with no Unipile call', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		try {
			registerOwnIdentity()
			__resetLinkedInMcpRegistryForTests()

			const res = await deliver(messageNew({ message: { is_sender: true, sender_id: OWN_SENDER } }))

			expect(await res.json()).toEqual({ ok: true, skipped: 'own_message' })
			expect(await messageEvents()).toHaveLength(0)
			expect(fetchSpy).not.toHaveBeenCalled()
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it('drops a message with no id as malformed_payload without a 5xx', async () => {
		const body = messageNew({ omit: ['id'] })
		const res = await deliver(body)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'malformed_payload' })
	})
})

// ── Transport: signature, JSON, unknown type, reconnect ────────────────────

describe('POST /webhook: transport', () => {
	it('returns 401 for a stale timestamp and writes nothing', async () => {
		const body = messageNew()
		const rawBody = JSON.stringify(body)
		const stale = Math.floor(Date.now() / 1000) - 3600
		const res = await deliver(null, { rawBody, header: signedHeader(rawBody, stale) })

		expect(res.status).toBe(401)
		expect(await messageEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)
	})

	it('returns 401 for a missing signature header', async () => {
		const res = await app.request('/api/integrations/linkedin-unipile/webhook', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(messageNew()),
		})
		expect(res.status).toBe(401)
	})

	it('returns 400 for a signed body that is not JSON', async () => {
		const res = await deliver(null, { rawBody: 'not json at all' })
		expect(res.status).toBe(400)
	})

	it('returns 500 when the webhook secret is not configured', async () => {
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.UNIPILE_WEBHOOK_SECRET
		const res = await deliver(messageNew())
		expect(res.status).toBe(500)
	})

	it('answers 200 skipped unknown_type for an event type with no map row', async () => {
		const res = await deliver({ ...messageNew(), type: 'relation.new' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'unknown_type' })
		expect(await deliveries()).toHaveLength(0)
	})

	it('keeps the account.reconnect re-enumeration path working', async () => {
		// The row has no unipile_acc_slug, so the handler reports it without calling Unipile.
		const res = await deliver({
			id: 'evt_reconnect',
			account_id: ACCOUNT_ID,
			type: 'account.reconnect',
			payload: {},
		})

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			ok: boolean
			appliedTo: Array<{ integrationId: string; diff: unknown }>
		}
		expect(json.ok).toBe(true)
		expect(json.appliedTo).toEqual([
			{
				integrationId,
				workspaceId,
				diff: { error: 'MISSING_UNIPILE_ACC_SLUG' },
			},
		])
		// account.reconnect is not an ingest row: no claims, no events.
		expect(await deliveries()).toHaveLength(0)
	})

	it('still reads the event kind from body.event for account.reconnect', async () => {
		const res = await deliver({ event: 'account.reconnect', account_id: 'acc_nobody' })
		expect(await res.json()).toEqual({ ok: true, appliedTo: [] })
	})
})
