import { createHmac, randomUUID } from 'node:crypto'
import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	integrations,
	objects,
	webhookDeliveries,
} from '@maskin/db/schema'
import { __resetLinkedInMcpRegistryForTests } from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { __resetSenderCachesForTests } from '../../lib/integrations/providers/linkedin-unipile/sender-resolution'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { __setLinkedInWebhookClientForTests } from '../../lib/integrations/providers/linkedin-unipile/webhook'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

/**
 * Route-level coverage for relation.new on POST
 * /api/integrations/linkedin-unipile/webhook against real Postgres: a new
 * connection from someone with a connection_requested contact becomes accepted
 * (entity id = the contact), every other connection becomes new (entity id =
 * the integration), and the handler never writes to contacts or calls getProfile.
 */

const SECRET = 'wes_test_secret'
const ACCOUNT_ID = 'acc_unipile_relation_01'
const OTHER_ID = 'ACoAAExampleRelationProviderId'
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
let getProfile: ReturnType<typeof vi.fn>

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

	// relation.new must never look the person up: any getProfile call is a failure.
	getProfile = vi.fn(async () => {
		throw new Error('getProfile must not be called for relation.new')
	})
	__setLinkedInWebhookClientForTests(() => ({ getProfile }) as unknown as LinkedInClient)

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

function relationNew(
	overrides: {
		envelopeId?: string
		otherId?: string
		publicIdentifier?: string | null
		payload?: Record<string, unknown>
	} = {},
) {
	const publicIdentifier =
		overrides.publicIdentifier === undefined ? 'jane-doe' : overrides.publicIdentifier
	return {
		id: overrides.envelopeId ?? `evt_${randomUUID()}`,
		created_at: '2026-10-04T11:20:45.000Z',
		account_id: ACCOUNT_ID,
		account_provider: 'LINKEDIN',
		account_name: 'Test Member',
		type: 'relation.new',
		payload: {
			object: 'UserRelation',
			id: overrides.otherId ?? OTHER_ID,
			...(publicIdentifier === null ? {} : { public_identifier: publicIdentifier }),
			first_name: 'Secret',
			last_name: 'Name',
			headline: 'secret headline',
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

async function connectionEvents() {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'linkedin.connection')))
}

async function deliveries() {
	return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, workspaceId))
}

async function insertContact(
	linkedinUrl: string | null,
	overrides: { status?: string; driver?: string | null } = {},
) {
	const row = await insertObject(db, workspaceId, getTestActorId(), {
		type: 'contact',
		status: overrides.status ?? 'connection_requested',
		metadata: linkedinUrl === null ? {} : { linkedin_url: linkedinUrl },
		driver: overrides.driver ?? null,
	})
	if (!row) throw new Error('contact insert returned no row')
	return row
}

// ── Classification ─────────────────────────────────────────────────────────

describe('relation.new classification', () => {
	it('records accepted against the contact for a connection_requested invitee', async () => {
		const driver = await insertActor(db)
		const contact = await insertContact('https://www.linkedin.com/in/Jane-Doe/?utm=x', {
			driver: driver.id,
		})

		const res = await deliver(relationNew())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const rows = await allEvents()
		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row?.entityType).toBe('linkedin.connection')
		expect(row?.action).toBe('accepted')
		expect(row?.entityId).toBe(contact.id)
		expect(row?.data).toEqual({
			provider: 'linkedin-unipile',
			unipile_event_type: 'relation.new',
			integration_id: integrationId,
			unipile_account_id: ACCOUNT_ID,
			external_id: OTHER_ID,
			envelope_id: expect.any(String),
			provider_timestamp: null,
			other_provider_id: OTHER_ID,
			other_public_identifier: 'jane-doe',
			contact_id: contact.id,
			contact_status: 'connection_requested',
			contact_driver_id: driver.id,
		})
		expect(JSON.stringify(row?.data)).not.toContain('Secret')
		expect(JSON.stringify(row?.data)).not.toContain('secret headline')
		expect(getProfile).not.toHaveBeenCalled()
	})

	it('records new against the integration when no contact matches', async () => {
		await insertContact('https://www.linkedin.com/in/someone-else')

		const res = await deliver(relationNew())
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const rows = await connectionEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('new')
		expect(rows[0]?.entityId).toBe(integrationId)
		const data = rows[0]?.data as Record<string, unknown>
		expect(data.other_public_identifier).toBe('jane-doe')
		expect(data).not.toHaveProperty('contact_id')
		expect(data).not.toHaveProperty('contact_status')
		expect(data).not.toHaveProperty('contact_driver_id')
		expect(getProfile).not.toHaveBeenCalled()
	})

	it('records new, not accepted, for a contact already in messaged', async () => {
		const contact = await insertContact('https://www.linkedin.com/in/jane-doe', {
			status: 'messaged',
		})

		await deliver(relationNew())

		const rows = await connectionEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('new')
		expect(rows[0]?.entityId).toBe(integrationId)
		const data = rows[0]?.data as Record<string, unknown>
		expect(data.contact_id).toBe(contact.id)
		expect(data.contact_status).toBe('messaged')
	})

	it('does not match martin against martin-emil-sloth-55a6655', async () => {
		await insertContact('https://www.linkedin.com/in/martin-emil-sloth-55a6655')

		await deliver(relationNew({ publicIdentifier: 'martin' }))

		const rows = await connectionEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('new')
		expect(rows[0]?.entityId).toBe(integrationId)
	})

	it('records new without a lookup when the payload has no public_identifier', async () => {
		await insertContact('https://www.linkedin.com/in/jane-doe')

		const res = await deliver(relationNew({ publicIdentifier: null }))
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const rows = await connectionEvents()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe('new')
		expect(rows[0]?.entityId).toBe(integrationId)
		expect((rows[0]?.data as Record<string, unknown>).other_public_identifier).toBeNull()
		expect(getProfile).not.toHaveBeenCalled()
	})

	it('drops a payload with no id as malformed_payload without a 5xx', async () => {
		const body = relationNew()
		Reflect.deleteProperty(body.payload as Record<string, unknown>, 'id')

		const res = await deliver(body)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'malformed_payload' })
		expect(await connectionEvents()).toHaveLength(0)
	})
})

// ── Writes nothing to contacts ─────────────────────────────────────────────

describe('relation.new writes nothing to the objects table', () => {
	it('leaves every object row untouched for an accepted delivery', async () => {
		await insertContact('https://www.linkedin.com/in/jane-doe')
		await insertContact('https://www.linkedin.com/in/other-person', { status: 'messaged' })
		const before = await db.select().from(objects).where(eq(objects.workspaceId, workspaceId))

		const res = await deliver(relationNew())
		expect(await res.json()).toEqual({ ok: true, count: 1 })

		const after = await db.select().from(objects).where(eq(objects.workspaceId, workspaceId))
		expect(after).toHaveLength(before.length)
		const byId = (rows: typeof before) =>
			Object.fromEntries(rows.map((r) => [r.id, r] as const)) as Record<string, (typeof before)[0]>
		expect(byId(after)).toEqual(byId(before))
	})
})

// ── Dedupe ─────────────────────────────────────────────────────────────────

describe('relation.new dedupe', () => {
	it('answers a replay with 200 skipped duplicate, writes one row and takes two claims', async () => {
		await insertContact('https://www.linkedin.com/in/jane-doe')
		const body = relationNew({ envelopeId: 'evt_rel_replay' })
		expect(await (await deliver(body)).json()).toEqual({ ok: true, count: 1 })

		const replay = await deliver(body)
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await connectionEvents()).toHaveLength(1)

		const claims = await deliveries()
		expect(claims.map((c) => c.externalId).sort()).toEqual(
			[`evt:${ACCOUNT_ID}:evt_rel_replay`, `rel:${ACCOUNT_ID}:${OTHER_ID}`].sort(),
		)
		expect(claims.every((c) => c.processedAt !== null)).toBe(true)
	})

	it('treats the same person under a new envelope id as a duplicate (known 14 day limit)', async () => {
		await deliver(relationNew({ envelopeId: 'evt_rel_one' }))

		const again = await deliver(relationNew({ envelopeId: 'evt_rel_two' }))
		expect(await again.json()).toEqual({ ok: true, skipped: 'duplicate' })
		expect(await connectionEvents()).toHaveLength(1)
		expect(await deliveries()).toHaveLength(2)
	})
})

// ── Account resolution and flag ────────────────────────────────────────────

describe('relation.new account resolution and flag', () => {
	it('answers 200 skipped no_active_integration for a revoked integration and writes no row', async () => {
		await db
			.update(integrations)
			.set({ status: 'revoked' })
			.where(eq(integrations.id, integrationId))

		const res = await deliver(relationNew())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'no_active_integration' })
		expect(await connectionEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)
	})

	it('answers 200 skipped flag_off with no events row and no claim row when the flag is off', async () => {
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()

		const res = await deliver(relationNew())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: 'flag_off' })
		expect(await connectionEvents()).toHaveLength(0)
		expect(await deliveries()).toHaveLength(0)
	})
})
