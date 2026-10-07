import { createHmac, randomUUID } from 'node:crypto'
import { events, INTEGRATION_STATUS_ACTIVE, integrations, objects } from '@maskin/db/schema'
import { __resetLinkedInMcpRegistryForTests } from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import {
	LOOKUP_TIMEOUT_MS,
	__resetSenderCachesForTests,
} from '../../lib/integrations/providers/linkedin-unipile/sender-resolution'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { __setLinkedInWebhookClientForTests } from '../../lib/integrations/providers/linkedin-unipile/webhook'
import { logger } from '../../lib/logger'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

/**
 * Route-level coverage for sender classification on POST
 * /api/integrations/linkedin-unipile/webhook against real Postgres: a message.new
 * from a known contact becomes received (entity id = the contact), a matched-
 * nothing sender becomes received_cold, and a sender we could not look up
 * becomes received_unresolved. Unipile is a fake client; contacts are real rows.
 */

const SECRET = 'wes_test_secret'
const ACCOUNT_ID = 'acc_unipile_classify_01'
const SENDER = 'ACoAAExampleSenderProviderId'
const FLAG = 'linkedin-unipile-events'
const WORK_BUDGET_MS = 4000

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

type ProfileReply = { status: number; body: Record<string, unknown> }

/** A fake Unipile client whose getProfile is the only live verb. */
function fakeClient(getProfile: LinkedInClient['getProfile']): LinkedInClient {
	return { getProfile } as unknown as LinkedInClient
}

function profileClient(reply: (identifier: string) => ProfileReply | Promise<ProfileReply>) {
	const getProfile = vi.fn(async (query: { account_id: string; identifier: string }) => {
		const r = await reply(query.identifier)
		return { status: r.status, body: r.body, headers: {} as Record<string, string> }
	})
	__setLinkedInWebhookClientForTests(() => fakeClient(getProfile as never))
	return getProfile
}

function profileOf(publicIdentifier: string): ProfileReply {
	return {
		status: 200,
		body: {
			object: 'UserProfile',
			public_identifier: publicIdentifier,
			display_name: 'Secret Name',
		},
	}
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

beforeEach(async () => {
	process.env.UNIPILE_WEBHOOK_SECRET = SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.UNIPILE_BASE_URL = 'http://unipile.invalid'
	process.env.UNIPILE_API_KEY = 'test-api-key'
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY

	await sql`TRUNCATE webhook_deliveries`
	__resetLinkedInMcpRegistryForTests()
	__resetSenderCachesForTests()

	const owner = await insertActor(db)
	ownerActorId = owner.id
	const ws = await insertWorkspace(db, getTestActorId())
	workspaceId = ws.id
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
		})
		.returning()
	if (!row) throw new Error('integration insert returned no row')
	integrationId = row.id

	process.env.FF_TESTER_ACTOR_IDS = ownerActorId
	process.env.FF_TESTER_FEATURES = FLAG
	_resetFeatureFlagConfig()
})

afterEach(() => {
	__setLinkedInWebhookClientForTests(null)
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

// ── Helpers ────────────────────────────────────────────────────────────────

function messageNew(
	overrides: {
		messageId?: string
		chatId?: string
		senderId?: string
		isSender?: boolean
		payload?: Record<string, unknown>
	} = {},
) {
	const messageId = overrides.messageId ?? `msg_${randomUUID()}`
	return {
		id: `evt_${randomUUID()}`,
		created_at: '2026-10-04T10:15:30.000Z',
		account_id: ACCOUNT_ID,
		account_provider: 'LINKEDIN',
		account_name: 'Test Member',
		type: 'message.new',
		payload: {
			id: messageId,
			chat_id: overrides.chatId ?? 'chat_1',
			timestamp: '2026-10-04T10:15:29.000Z',
			sender_id: overrides.senderId ?? SENDER,
			is_sender: overrides.isSender ?? false,
			text: 'hello, secret message text',
			...overrides.payload,
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

async function allEvents() {
	return db.select().from(events).where(eq(events.workspaceId, workspaceId))
}

async function messageEvents() {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'linkedin.message')))
}

async function insertContact(
	linkedinUrl: string | null,
	overrides: { status?: string; driver?: string | null; workspaceId?: string } = {},
) {
	const row = await insertObject(db, overrides.workspaceId ?? workspaceId, getTestActorId(), {
		type: 'contact',
		status: overrides.status ?? 'messaged',
		metadata: linkedinUrl === null ? {} : { linkedin_url: linkedinUrl },
		driver: overrides.driver ?? null,
	})
	if (!row) throw new Error('contact insert returned no row')
	return row
}

// ── Known contact ──────────────────────────────────────────────────────────

describe('known contact', () => {
	it('records received with the contact id as entity id and writes nothing else', async () => {
		const driver = await insertActor(db)
		const contact = await insertContact('https://www.linkedin.com/in/Jane-Doe/?utm=x', {
			driver: driver.id,
		})
		const getProfile = profileClient(() => profileOf('jane-doe'))

		const res = await deliver(messageNew({ messageId: 'msg_known' }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		expect(getProfile).toHaveBeenCalledTimes(1)
		expect(getProfile).toHaveBeenCalledWith({ account_id: ACCOUNT_ID, identifier: SENDER })

		const rows = await allEvents()
		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row?.entityType).toBe('linkedin.message')
		expect(row?.action).toBe('received')
		expect(row?.entityId).toBe(contact.id)
		expect(row?.data).toEqual({
			provider: 'linkedin-unipile',
			unipile_event_type: 'message.new',
			integration_id: integrationId,
			unipile_account_id: ACCOUNT_ID,
			external_id: 'msg_known',
			envelope_id: expect.any(String),
			provider_timestamp: '2026-10-04T10:15:29.000Z',
			chat_id: 'chat_1',
			message_id: 'msg_known',
			sender_provider_id: SENDER,
			direction: 'inbound',
			direction_source: 'is_sender',
			sender_public_identifier: 'jane-doe',
			contact_id: contact.id,
			contact_status: 'messaged',
			contact_driver_id: driver.id,
		})
		expect(JSON.stringify(row?.data)).not.toContain('secret message text')
		expect(JSON.stringify(row?.data)).not.toContain('Secret Name')

		// The contact itself is not touched by the webhook.
		const [after] = await db.select().from(objects).where(eq(objects.id, contact.id))
		expect(after?.activeSessionId).toBeNull()
	})

	it('still records received for a contact in not_interested', async () => {
		const contact = await insertContact('https://linkedin.com/in/jane-doe', {
			status: 'not_interested',
		})
		profileClient(() => profileOf('jane-doe'))

		await deliver(messageNew())

		const rows = await messageEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('received')
		expect(rows[0]?.entityId).toBe(contact.id)
		expect((rows[0]?.data as Record<string, unknown>).contact_status).toBe('not_interested')
	})

	it('matches the exact /in/ segment: martin does not match martin-emil-sloth-55a6655', async () => {
		await insertContact('https://www.linkedin.com/in/martin-emil-sloth-55a6655')
		profileClient(() => profileOf('martin'))

		await deliver(messageNew())

		const rows = await messageEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('received_cold')
	})

	it('matches a contact whose stored url holds the slug percent-encoded', async () => {
		const contact = await insertContact('https://linkedin.com/in/j%C3%B8rgen-s')
		profileClient(() => profileOf('jørgen-s'))

		await deliver(messageNew())

		const rows = await messageEvents()
		expect(rows[0]?.action).toBe('received')
		expect(rows[0]?.entityId).toBe(contact.id)
	})

	it('ignores a matching contact that lives in another workspace', async () => {
		const otherWs = await insertWorkspace(db, getTestActorId())
		await insertContact('https://linkedin.com/in/jane-doe', { workspaceId: otherWs.id })
		profileClient(() => profileOf('jane-doe'))

		await deliver(messageNew())

		expect((await messageEvents())[0]?.action).toBe('received_cold')
	})

	it('prefers the contact driven by the owning rep when two contacts match, and warns', async () => {
		const otherRep = await insertActor(db)
		await insertContact('https://linkedin.com/in/jane-doe', { driver: otherRep.id })
		const owned = await insertContact('https://www.linkedin.com/in/Jane-Doe/', {
			driver: ownerActorId,
		})
		profileClient(() => profileOf('jane-doe'))
		const warn = vi.spyOn(logger, 'warn')

		await deliver(messageNew())

		const rows = await messageEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.entityId).toBe(owned.id)
		const warned = warn.mock.calls.filter(([msg]) => String(msg).includes('several contacts match'))
		expect(warned).toHaveLength(1)
	})

	it('uses the public identifier from the payload and makes no getProfile call', async () => {
		const contact = await insertContact('https://linkedin.com/in/jane-doe')
		const getProfile = profileClient(() => profileOf('someone-else'))

		await deliver(messageNew({ payload: { sender_public_identifier: 'Jane-Doe' } }))

		expect(getProfile).not.toHaveBeenCalled()
		const rows = await messageEvents()
		expect(rows[0]?.action).toBe('received')
		expect(rows[0]?.entityId).toBe(contact.id)
	})
})

// ── Cold ───────────────────────────────────────────────────────────────────

describe('cold sender', () => {
	it('records received_cold against the integration with ids only and no trigger work', async () => {
		profileClient(() => profileOf('nobody-we-know'))

		const res = await deliver(messageNew({ messageId: 'msg_cold' }))
		expect(res.status).toBe(200)

		const rows = await allEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('received_cold')
		expect(rows[0]?.entityId).toBe(integrationId)
		expect(rows[0]?.data).toEqual({
			provider: 'linkedin-unipile',
			unipile_event_type: 'message.new',
			integration_id: integrationId,
			unipile_account_id: ACCOUNT_ID,
			external_id: 'msg_cold',
			envelope_id: expect.any(String),
			provider_timestamp: '2026-10-04T10:15:29.000Z',
			chat_id: 'chat_1',
			message_id: 'msg_cold',
			sender_provider_id: SENDER,
			direction: 'inbound',
			direction_source: 'is_sender',
		})
		const serialized = JSON.stringify(rows[0]?.data)
		expect(serialized).not.toContain('nobody-we-know')
		expect(serialized).not.toContain('Secret Name')
		expect(serialized).not.toContain('secret message text')
	})

	it('records received_cold for a contact with an empty linkedin_url', async () => {
		await insertContact(null)
		await insertContact('')
		profileClient(() => profileOf('jane-doe'))

		await deliver(messageNew())

		expect((await messageEvents())[0]?.action).toBe('received_cold')
	})
})

// ── Unresolved ─────────────────────────────────────────────────────────────

describe('unresolved sender', () => {
	it('answers 200 inside the work budget and records received_unresolved when the lookup never resolves', async () => {
		await insertContact('https://linkedin.com/in/jane-doe')
		profileClient(() => new Promise<ProfileReply>(() => {}))

		const started = Date.now()
		const res = await deliver(messageNew())
		const elapsed = Date.now() - started

		expect(res.status).toBe(200)
		expect(elapsed).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS - 100)
		expect(elapsed).toBeLessThan(WORK_BUDGET_MS)
		const rows = await messageEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('received_unresolved')
		expect(rows[0]?.entityId).toBe(integrationId)
		expect(rows[0]?.data).not.toHaveProperty('contact_id')
	})

	it.each([
		['429', { status: 429, body: { error: 'rate limited' } }],
		['503', { status: 503, body: {} }],
		['a profile with no public identifier', { status: 200, body: { object: 'UserProfile' } }],
	])('records received_unresolved on %s and still answers 200', async (_label, reply) => {
		profileClient(() => reply)

		const res = await deliver(messageNew())

		expect(res.status).toBe(200)
		expect((await messageEvents())[0]?.action).toBe('received_unresolved')
	})

	it('records received_unresolved when the lookup throws', async () => {
		profileClient(() => {
			throw new Error('socket hang up')
		})

		const res = await deliver(messageNew())

		expect(res.status).toBe(200)
		expect((await messageEvents())[0]?.action).toBe('received_unresolved')
	})

	it('records received_unresolved when the message carries no sender id', async () => {
		const getProfile = profileClient(() => profileOf('jane-doe'))
		const body = messageNew()
		Reflect.deleteProperty(body.payload, 'sender_id')
		// No sender_id means direction rests on is_sender alone, which says inbound.

		const res = await deliver(body)

		expect(res.status).toBe(200)
		expect(getProfile).not.toHaveBeenCalled()
		expect((await messageEvents())[0]?.action).toBe('received_unresolved')
	})

	it('puts a 2.5 second abort signal on the real client request (no retry, single attempt)', async () => {
		__setLinkedInWebhookClientForTests(null)
		const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				calls.push({ url: String(url), signal: init?.signal })
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
					)
				})
			}),
		)

		const started = Date.now()
		const res = await deliver(messageNew())
		const elapsed = Date.now() - started

		expect(res.status).toBe(200)
		expect(elapsed).toBeLessThan(WORK_BUDGET_MS)
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain(`/v2/${ACCOUNT_ID}/users/${SENDER}`)
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
		expect((await messageEvents())[0]?.action).toBe('received_unresolved')
	})
})

// ── Caches, own messages, concurrency ──────────────────────────────────────

describe('lookups', () => {
	it('makes zero Unipile calls for a second message in the same chat', async () => {
		const contact = await insertContact('https://linkedin.com/in/jane-doe')
		const getProfile = profileClient(() => profileOf('jane-doe'))

		await deliver(messageNew({ messageId: 'msg_a', chatId: 'chat_same' }))
		await deliver(messageNew({ messageId: 'msg_b', chatId: 'chat_same' }))

		expect(getProfile).toHaveBeenCalledTimes(1)
		const rows = await messageEvents()
		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.action === 'received' && r.entityId === contact.id)).toBe(true)
	})

	it('reuses the sender profile across chats and makes one getProfile call per sender', async () => {
		await insertContact('https://linkedin.com/in/jane-doe')
		const getProfile = profileClient(() => profileOf('jane-doe'))

		await deliver(messageNew({ chatId: 'chat_x' }))
		await deliver(messageNew({ chatId: 'chat_y' }))

		expect(getProfile).toHaveBeenCalledTimes(1)
		expect((await messageEvents()).map((r) => r.action)).toEqual(['received', 'received'])
	})

	it('falls back to a fresh lookup when the cached chat contact has been deleted', async () => {
		const first = await insertContact('https://linkedin.com/in/jane-doe')
		profileClient(() => profileOf('jane-doe'))
		await deliver(messageNew({ chatId: 'chat_gone' }))
		await db.delete(objects).where(eq(objects.id, first.id))

		await deliver(messageNew({ chatId: 'chat_gone' }))

		const rows = await messageEvents()
		expect(rows.map((r) => r.action).sort()).toEqual(['received', 'received_cold'])
	})

	it('makes zero getProfile calls for an own message', async () => {
		const getProfile = profileClient(() => profileOf('jane-doe'))

		const res = await deliver(messageNew({ isSender: true }))

		expect(res.status).toBe(200)
		expect(getProfile).not.toHaveBeenCalled()
		expect(await allEvents()).toHaveLength(0)
	})

	it('never has more than 5 lookups in flight across a burst of 10 distinct unknown senders', async () => {
		let inFlight = 0
		let peak = 0
		const getProfile = profileClient(async (identifier) => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise((r) => setTimeout(r, 120))
			inFlight--
			return profileOf(`slug-${identifier}`)
		})

		const responses = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				deliver(messageNew({ senderId: `ACoAASender${i}`, chatId: `chat_burst_${i}` })),
			),
		)

		expect(responses.every((r) => r.status === 200)).toBe(true)
		expect(getProfile).toHaveBeenCalledTimes(10)
		expect(peak).toBeLessThanOrEqual(5)
		expect(peak).toBeGreaterThan(1)
		expect((await messageEvents()).every((r) => r.action === 'received_cold')).toBe(true)
	})

	it('frees the lookup slot when a call hangs, so later senders are still looked up', async () => {
		const hang = new Promise<ProfileReply>(() => {})
		const getProfile = profileClient((identifier) =>
			identifier === 'ACoAAHang' ? hang : profileOf('jane-doe'),
		)
		await insertContact('https://linkedin.com/in/jane-doe')

		await deliver(messageNew({ senderId: 'ACoAAHang', chatId: 'chat_hang' }))
		const res = await deliver(messageNew({ senderId: 'ACoAAOk', chatId: 'chat_ok' }))

		expect(res.status).toBe(200)
		expect(getProfile).toHaveBeenCalledTimes(2)
		expect((await messageEvents()).map((r) => r.action).sort()).toEqual([
			'received',
			'received_unresolved',
		])
	})
})
