import { createHmac } from 'node:crypto'
import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	integrations,
	objects,
	sessions,
	triggers,
	webhookDeliveries,
} from '@maskin/db/schema'
import {
	__resetLinkedInMcpRegistryForTests,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import accountReconnectFixture from '../../lib/integrations/providers/linkedin-unipile/__fixtures__/account.reconnect.json'
import messageNewFixture from '../../lib/integrations/providers/linkedin-unipile/__fixtures__/message.new.json'
import ownSendFixture from '../../lib/integrations/providers/linkedin-unipile/__fixtures__/message.new.own-send.json'
import relationNewFixture from '../../lib/integrations/providers/linkedin-unipile/__fixtures__/relation.new.json'
import { readUnipileEnvelope } from '../../lib/integrations/providers/linkedin-unipile/envelope'
import {
	__setLinkedInClientForTests,
	listLinkedInMessages,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import { __resetSenderCachesForTests } from '../../lib/integrations/providers/linkedin-unipile/sender-resolution'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { __setLinkedInWebhookClientForTests } from '../../lib/integrations/providers/linkedin-unipile/webhook'
import { logger } from '../../lib/logger'
import { insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

/**
 * End to end, in fixture form, for the Unipile webhook events bet: signed
 * deliveries from __fixtures__ are posted to the bet-branch webhook route against
 * real Postgres, and the reply path is driven the way a webhook-woken session and
 * a sweep-woken session would drive it. Each describe block below is one smoke
 * assertion from section 11 of the tech spec, in fixture form.
 *
 * Everything on the Unipile side is a fake client we wrote. That checks our logic,
 * not Unipile's behaviour: real payload fields, real retry timing, the endpoint
 * allowlist and the live wake leg can only be seen on the deployed endpoint, in
 * shadow mode (see the shadow-mode runbook). The secret below is a test secret;
 * the production secret is never used here.
 */

const TEST_SECRET = 'wes_test_secret_fixture_replay'
const ACCOUNT_ID = messageNewFixture.account_id
const OWN_PROVIDER_ID = ownSendFixture.payload.sender_id
const SENDER_PROVIDER_ID = messageNewFixture.payload.sender_id
const CHAT_ID = messageNewFixture.payload.chat_id
const INBOUND_MESSAGE_ID = messageNewFixture.payload.id
const FLAG = 'linkedin-unipile-events'
const REPLY_PATH = '/api/integrations/linkedin-unipile/reply'

// The slug getProfile returns for the fixture sender, and the slug the fixture
// relation.new carries. The two contacts below are stored with these in their urls.
const SENDER_SLUG = 'example-sender-1a2b3c'
const INVITEE_SLUG = relationNewFixture.payload.public_identifier

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
let integrationId: string
let actorId: string
let repliedContactId: string
let inviteeContactId: string

type HttpResult = { status: number; body: unknown; headers: Record<string, string> }

/** Counts every Unipile verb the webhook path could reach for. */
let webhookGetProfile: ReturnType<typeof vi.fn>
let webhookClientBuilt: ReturnType<typeof vi.fn>
let getManagedCompanyPages: ReturnType<typeof vi.fn>

const logInfo = vi.spyOn(logger, 'info')

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
	process.env.UNIPILE_WEBHOOK_SECRET = TEST_SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.UNIPILE_BASE_URL = 'http://unipile.invalid'
	process.env.UNIPILE_API_KEY = 'test-api-key'
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY

	await sql`TRUNCATE webhook_deliveries`
	await sql`TRUNCATE idempotency_records`
	__resetLinkedInMcpRegistryForTests()
	__resetSenderCachesForTests()
	logInfo.mockClear()

	// The integration is owned by the test actor, so the same actor is the flag
	// tester on the webhook path and the caller on the reply route.
	actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	workspaceId = ws.id
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			externalId: ACCOUNT_ID,
			unipileAccSlug: 'own-slug',
			credentials: encrypt(JSON.stringify({ account_id: ACCOUNT_ID })),
			actorId,
			createdBy: actorId,
		})
		.returning()
	if (!row) throw new Error('integration insert returned no row')
	integrationId = row.id

	process.env.FF_TESTER_ACTOR_IDS = actorId
	process.env.FF_TESTER_FEATURES = FLAG
	_resetFeatureFlagConfig()

	const replied = await insertContact(`https://www.linkedin.com/in/${SENDER_SLUG}/`, 'messaged')
	repliedContactId = replied.id
	const invitee = await insertContact(
		`https://www.linkedin.com/in/${INVITEE_SLUG}`,
		'connection_requested',
	)
	inviteeContactId = invitee.id

	webhookGetProfile = vi.fn(
		async (query: { account_id: string; identifier: string }): Promise<HttpResult> => {
			if (query.identifier === 'me') {
				return {
					status: 200,
					body: {
						object: 'UserProfile',
						provider_id: OWN_PROVIDER_ID,
						public_identifier: 'own-slug',
						display_name: 'Test Member',
					},
					headers: {},
				}
			}
			if (query.identifier === SENDER_PROVIDER_ID) {
				return {
					status: 200,
					body: {
						object: 'UserProfile',
						public_identifier: SENDER_SLUG,
						display_name: 'Secret Name',
					},
					headers: {},
				}
			}
			return { status: 404, body: {}, headers: {} }
		},
	)
	getManagedCompanyPages = vi.fn(
		async (): Promise<HttpResult> => ({
			status: 200,
			body: { object: 'ManagedCompanyPages', data: [] },
			headers: {},
		}),
	)
	webhookClientBuilt = vi.fn(
		() => ({ getProfile: webhookGetProfile, getManagedCompanyPages }) as unknown as LinkedInClient,
	)
	__setLinkedInWebhookClientForTests(webhookClientBuilt)
})

afterEach(() => {
	__setLinkedInWebhookClientForTests(null)
	__setLinkedInClientForTests(null)
})

// ── Helpers ────────────────────────────────────────────────────────────────

async function insertContact(linkedinUrl: string, status: string) {
	const row = await insertObject(db, workspaceId, actorId, {
		type: 'contact',
		status,
		metadata: { linkedin_url: linkedinUrl },
	})
	if (!row) throw new Error('contact insert returned no row')
	return row
}

function sign(rawBody: string, secret = TEST_SECRET, tSec = Math.floor(Date.now() / 1000)) {
	const v0 = createHmac('sha256', secret).update(`${tSec}.${rawBody}`).digest('hex')
	return `t=${tSec},v0=${v0}`
}

/** Posts a raw body to the webhook route, signed with the test secret unless told otherwise. */
function post(rawBody: string, header = sign(rawBody)) {
	return app.request('/api/integrations/linkedin-unipile/webhook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'unipile-signature': header },
		body: rawBody,
	})
}

/** Replays a fixture, optionally with fields overridden at the envelope level. */
function replay(fixture: object, overrides: Record<string, unknown> = {}) {
	return post(JSON.stringify({ ...fixture, ...overrides }))
}

function postReply(body: Record<string, unknown>) {
	return app.request(REPLY_PATH, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

async function workspaceEvents() {
	return db.select().from(events).where(eq(events.workspaceId, workspaceId))
}

async function eventsOf(entityType: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, entityType)))
}

async function claims() {
	return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, workspaceId))
}

function deliveryLogLines(): Array<Record<string, unknown>> {
	return logInfo.mock.calls
		.filter(([msg]) => msg === 'linkedin-unipile webhook: delivery')
		.map(([, fields]) => fields as Record<string, unknown>)
}

function registerOwnIdentity() {
	registerLinkedInMcpInstance({
		workspaceId,
		actorId,
		integrationId,
		unipileAccountId: ACCOUNT_ID,
		unipileAccSlug: 'own-slug',
		identityType: 'personal',
		identityUrn: `urn:li:person:${OWN_PROVIDER_ID}`,
		identitySlug: 'personal',
		displayName: 'Own Member',
		mailboxId: null,
		messagingEnabled: true,
	})
}

// ── Smoke assertion 1: one signed message.new, one events row ──────────────

describe('smoke 1: a signed message.new from a known contact is one events row', () => {
	it('writes exactly one (linkedin.message, received) row for the contact and nothing else', async () => {
		const [contactBefore] = await db.select().from(objects).where(eq(objects.id, repliedContactId))

		const res = await replay(messageNewFixture)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const rows = await workspaceEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			entityType: 'linkedin.message',
			action: 'received',
			entityId: repliedContactId,
		})
		expect(JSON.stringify(rows[0]?.data)).not.toContain('fixture text')

		// Bookkeeping only: the two dedupe claims, both settled. No session, no
		// trigger, and the contact row is exactly as it was.
		const claimRows = await claims()
		expect(claimRows).toHaveLength(2)
		expect(claimRows.every((c) => c.processedAt !== null)).toBe(true)
		const sessionRows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.workspaceId, workspaceId))
		const triggerRows = await db
			.select()
			.from(triggers)
			.where(eq(triggers.workspaceId, workspaceId))
		expect(sessionRows).toEqual([])
		expect(triggerRows).toEqual([])
		const [contactAfter] = await db.select().from(objects).where(eq(objects.id, repliedContactId))
		expect(contactAfter).toEqual(contactBefore)
		expect(contactAfter?.activeSessionId).toBeNull()
	})
})

// ── Smoke assertion 2: direction ───────────────────────────────────────────

describe('smoke 2: our own send is dropped and a reply is not', () => {
	it('drops is_sender true as own_message with direction_source is_sender', async () => {
		const res = await replay(ownSendFixture)

		expect(await res.json()).toEqual({ ok: true, skipped: 'own_message' })
		expect(await workspaceEvents()).toHaveLength(0)
		expect(deliveryLogLines()).toEqual([
			expect.objectContaining({
				outcome: 'dropped',
				reason: 'own_message',
				direction_source: 'is_sender',
			}),
		])
	})

	it('does not drop is_sender false, and records direction_source is_sender on the event', async () => {
		const res = await replay(messageNewFixture)

		expect(await res.json()).toEqual({ ok: true, count: 1 })
		const rows = await eventsOf('linkedin.message')
		expect(rows).toHaveLength(1)
		expect((rows[0]?.data as Record<string, unknown>).direction_source).toBe('is_sender')
		expect((rows[0]?.data as Record<string, unknown>).direction).toBe('inbound')
	})

	it('still drops an own send with the in-process registry cleared, and calls Unipile for nothing', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		try {
			registerOwnIdentity()
			__resetLinkedInMcpRegistryForTests()

			const res = await replay(ownSendFixture)

			expect(await res.json()).toEqual({ ok: true, skipped: 'own_message' })
			expect(await workspaceEvents()).toHaveLength(0)
			expect(fetchSpy).not.toHaveBeenCalled()
			expect(webhookClientBuilt).not.toHaveBeenCalled()
			expect(webhookGetProfile).not.toHaveBeenCalled()
		} finally {
			fetchSpy.mockRestore()
		}
	})
})

// ── Smoke assertion 3: relation.new ────────────────────────────────────────

describe('smoke 3: relation.new for a connection_requested contact is accepted', () => {
	it('writes (linkedin.connection, accepted) for that contact, slug read from the payload', async () => {
		const res = await replay(relationNewFixture)

		expect(await res.json()).toEqual({ ok: true, count: 1 })
		const rows = await eventsOf('linkedin.connection')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ action: 'accepted', entityId: inviteeContactId })
		expect((rows[0]?.data as Record<string, unknown>).other_public_identifier).toBe(INVITEE_SLUG)
		// The slug came from the payload, so nothing was looked up, and the contact is untouched.
		expect(webhookGetProfile).not.toHaveBeenCalled()
		const [contact] = await db.select().from(objects).where(eq(objects.id, inviteeContactId))
		expect(contact?.status).toBe('connection_requested')
	})
})

// ── Smoke assertion 4: signature ───────────────────────────────────────────

describe('smoke 4: signature check, test secret only', () => {
	it('returns 200 for a fixture signed with the test secret and 401 with one byte changed', async () => {
		const rawBody = JSON.stringify(messageNewFixture)
		const header = sign(rawBody)

		const tampered = rawBody.replace('fixture text', 'fixturf text')
		expect(tampered).not.toBe(rawBody)
		expect(tampered.length).toBe(rawBody.length)
		const rejected = await post(tampered, header)
		expect(rejected.status).toBe(401)
		expect(await workspaceEvents()).toHaveLength(0)
		expect(await claims()).toHaveLength(0)

		const accepted = await post(rawBody, header)
		expect(accepted.status).toBe(200)
		expect(await workspaceEvents()).toHaveLength(1)
	})

	it('returns 401 for a fixture signed with some other secret', async () => {
		const rawBody = JSON.stringify(messageNewFixture)
		const res = await post(rawBody, sign(rawBody, 'not_the_test_secret'))
		expect(res.status).toBe(401)
		expect(await workspaceEvents()).toHaveLength(0)
	})
})

// ── Smoke assertions 6 and 7: account.reconnect and retries ────────────────

describe('smoke 6: account.reconnect is parsed and triggers re-enumeration', () => {
	it('has a top-level type and account_id, and the route re-enumerates the account', async () => {
		const envelope = readUnipileEnvelope(accountReconnectFixture)
		expect(envelope.type).toBe('account.reconnect')
		expect(envelope.accountId).toBe(ACCOUNT_ID)

		const res = await replay(accountReconnectFixture)

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			ok: boolean
			appliedTo: Array<{ integrationId: string; diff: Record<string, unknown> }>
		}
		expect(json.ok).toBe(true)
		expect(json.appliedTo).toHaveLength(1)
		expect(json.appliedTo[0]?.integrationId).toBe(integrationId)
		expect(json.appliedTo[0]?.diff).not.toHaveProperty('error')
		expect(json.appliedTo[0]?.diff.registered).toHaveLength(1)
		expect(webhookGetProfile).toHaveBeenCalledWith({ account_id: ACCOUNT_ID, identifier: 'me' })
		expect(getManagedCompanyPages).toHaveBeenCalledTimes(1)

		const rows = await eventsOf('linkedin.account')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ action: 'status_changed', entityId: integrationId })
	})
})

describe('smoke 7: retries are skipped as duplicates', () => {
	it('skips the same fixture replayed under the same envelope id', async () => {
		expect(await (await replay(messageNewFixture)).json()).toEqual({ ok: true, count: 1 })

		const again = await replay(messageNewFixture)

		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await eventsOf('linkedin.message')).toHaveLength(1)
	})

	it('skips a new envelope id with the same message id, via the message-key claim', async () => {
		await replay(messageNewFixture)
		const newEnvelopeId = 'evt_retry_under_a_new_envelope_id'

		const again = await replay(messageNewFixture, { id: newEnvelopeId })

		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await eventsOf('linkedin.message')).toHaveLength(1)
		const keys = (await claims()).map((c) => c.externalId)
		expect(keys).toContain(`msg:${ACCOUNT_ID}:${INBOUND_MESSAGE_ID}`)
		// The new envelope's claim rolled back with the duplicate message claim.
		expect(keys).not.toContain(`evt:${ACCOUNT_ID}:${newEnvelopeId}`)
	})
})

// ── Sweep comparison and the reply path ────────────────────────────────────

/**
 * The mailbox the sweep reads, newest first: the reply from the prospect, our
 * earlier outreach, and (after we answer) our own send. is_sender is what Unipile
 * puts on list_messages rows; the sweep treats from_me false as inbound.
 */
function mailboxClient(sent: Array<{ thread_id: string; body: string }>) {
	const listMessages = vi.fn(
		async (): Promise<HttpResult> => ({
			status: 200,
			body: {
				data: [
					{
						id: ownSendFixture.payload.id,
						chat_id: CHAT_ID,
						sender_id: OWN_PROVIDER_ID,
						text: 'answer',
						timestamp: ownSendFixture.payload.timestamp,
						is_sender: true,
					},
					{
						id: INBOUND_MESSAGE_ID,
						chat_id: CHAT_ID,
						sender_id: SENDER_PROVIDER_ID,
						text: 'reply',
						timestamp: messageNewFixture.payload.timestamp,
						is_sender: false,
					},
					{
						id: 'msg_fixture_outreach',
						chat_id: CHAT_ID,
						sender_id: OWN_PROVIDER_ID,
						text: 'outreach',
						timestamp: '2026-10-03T09:00:00.000Z',
						is_sender: 1,
					},
				],
			},
			headers: {},
		}),
	)
	const reply = vi.fn(async (payload: { thread_id: string; body: string }): Promise<HttpResult> => {
		sent.push({ thread_id: payload.thread_id, body: payload.body })
		return {
			status: 200,
			body: { id: `msg_sent_${sent.length}`, sent_at: '2026-10-04T10:19:59.000Z' },
			headers: {},
		}
	})
	__setLinkedInClientForTests(() => ({ listMessages, reply }) as unknown as LinkedInClient)
	return { listMessages, reply }
}

describe('sweep comparison over the fixture set', () => {
	it('finds exactly the inbound messages the webhook recorded, with no direction drops', async () => {
		const sent: Array<{ thread_id: string; body: string }> = []
		mailboxClient(sent)

		// The fixture set: one reply from a known contact, one own send, one
		// connection acceptance. Own send arrives after the reply, as it would live.
		await replay(messageNewFixture)
		await replay(ownSendFixture)
		await replay(relationNewFixture)

		const received = (await eventsOf('linkedin.message')).filter((e) => e.action === 'received')
		const webhookInbound = received.map((e) => (e.data as { message_id: string }).message_id).sort()

		const mailbox = await listLinkedInMessages({ db, actorId, workspaceId }, { thread_id: CHAT_ID })
		const sweepInbound = mailbox.messages
			.filter((m) => !m.from_me)
			.map((m) => m.message_id)
			.sort()

		expect(sweepInbound).toEqual([INBOUND_MESSAGE_ID])
		expect(webhookInbound).toEqual(sweepInbound)

		const directionSources = (await eventsOf('linkedin.message')).map(
			(e) => (e.data as { direction_source: string }).direction_source,
		)
		expect(directionSources).toEqual(['is_sender'])
		const drops = (await eventsOf('linkedin.webhook')).map(
			(e) => (e.data as { reason: string }).reason,
		)
		expect(drops.filter((r) => r === 'direction_unknown')).toHaveLength(0)
		expect(drops.filter((r) => r === 'direction_conflict')).toHaveLength(0)
		// Three deliveries in, two events out: the own send is the one drop.
		expect(await workspaceEvents()).toHaveLength(2)
	})
})

describe('smoke 8, 10 and 11 in fixture form: one reply, whichever path gets there first', () => {
	it('carries the contact id and the message id the reply prompt reads', async () => {
		await replay(messageNewFixture)

		const [row] = await eventsOf('linkedin.message')
		expect(row?.entityId).toBe(repliedContactId)
		expect(row?.data).toMatchObject({
			contact_id: repliedContactId,
			chat_id: CHAT_ID,
			message_id: INBOUND_MESSAGE_ID,
			integration_id: integrationId,
		})
	})

	it('sends one message when the webhook path answers first and the sweep path answers the same message', async () => {
		const sent: Array<{ thread_id: string; body: string }> = []
		const { reply, listMessages } = mailboxClient(sent)
		await replay(messageNewFixture)
		const [row] = await eventsOf('linkedin.message')
		const data = row?.data as { chat_id: string; message_id: string }

		// Webhook path: the wake prompt passes chat_id and message_id from the event.
		const viaWebhook = await postReply({
			thread_id: data.chat_id,
			body: 'draft from the webhook session',
			in_reply_to_message_id: data.message_id,
		})
		expect(viaWebhook.status).toBe(200)
		const first = (await viaWebhook.json()) as { message_id: string; replayed: boolean }
		expect(first.replayed).toBe(false)

		// Sweep path: the loop reads the chat and answers its latest inbound message.
		const mailbox = await listLinkedInMessages({ db, actorId, workspaceId }, { thread_id: CHAT_ID })
		const latestInbound = mailbox.messages.find((m) => !m.from_me)
		expect(latestInbound?.message_id).toBe(data.message_id)
		const viaSweep = await postReply({
			thread_id: CHAT_ID,
			body: 'a different draft from the sweep session',
			in_reply_to_message_id: latestInbound?.message_id,
		})
		expect(viaSweep.status).toBe(200)
		const second = (await viaSweep.json()) as { message_id: string; replayed: boolean }

		expect(second.replayed).toBe(true)
		expect(second.message_id).toBe(first.message_id)
		expect(reply).toHaveBeenCalledTimes(1)
		expect(sent).toEqual([{ thread_id: CHAT_ID, body: 'draft from the webhook session' }])
		expect(listMessages).toHaveBeenCalledTimes(1)
	})

	it('sends one message when the sweep path answers first and the webhook path answers after', async () => {
		const sent: Array<{ thread_id: string; body: string }> = []
		const { reply } = mailboxClient(sent)
		await replay(messageNewFixture)

		const viaSweep = await postReply({
			thread_id: CHAT_ID,
			body: 'sweep draft',
			in_reply_to_message_id: INBOUND_MESSAGE_ID,
		})
		const viaWebhook = await postReply({
			thread_id: CHAT_ID,
			body: 'webhook draft',
			in_reply_to_message_id: INBOUND_MESSAGE_ID,
		})

		expect(((await viaSweep.json()) as { replayed: boolean }).replayed).toBe(false)
		expect(((await viaWebhook.json()) as { replayed: boolean }).replayed).toBe(true)
		expect(reply).toHaveBeenCalledTimes(1)
	})

	it('wakes nobody: no session exists, and the contact has no active session', async () => {
		await replay(messageNewFixture)
		await replay(relationNewFixture)

		const sessionRows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.workspaceId, workspaceId))
		expect(sessionRows).toEqual([])
		const contacts = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'contact')))
		expect(contacts).toHaveLength(2)
		expect(contacts.every((c) => c.activeSessionId === null)).toBe(true)
	})
})
