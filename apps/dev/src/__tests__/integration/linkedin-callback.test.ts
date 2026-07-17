import { randomBytes } from 'node:crypto'
import { events, linkedinAccounts } from '@maskin/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The callback owns three DB-semantic guarantees that only a real Postgres
// can exercise: the workspace_id unique index (one account per workspace),
// the state CHECK constraint (only the six valid values persist), and the
// `handoff → syncing` upsert path that a re-connect on an already-linked
// workspace must take. All three are exercised below against the real DB.

vi.mock('../../lib/unipile/client', async () => {
	const actual = await vi.importActual<typeof import('../../lib/unipile/client')>(
		'../../lib/unipile/client',
	)
	return {
		...actual,
		readUnipileConfig: vi.fn(() => ({ apiKey: 'test-key', dsn: 'https://unipile.test' })),
		findAccountByName: vi.fn(),
		getAccountById: vi.fn(),
	}
})

const unipile = await import('../../lib/unipile/client')
const { default: linkedinRoutes } = await import('../../routes/linkedin')
const { encrypt } = await import('../../lib/crypto')

function buildApp() {
	return createIntegrationApp({ path: '/api/linkedin', module: linkedinRoutes })
}

function buildState(
	overrides?: Partial<{
		workspaceId: string
		actorId: string
		agentId: string
		nonce: string
		ts: number
	}>,
): string {
	const payload = {
		workspaceId: overrides?.workspaceId ?? '00000000-0000-0000-0000-000000000000',
		actorId: overrides?.actorId ?? getTestActorId(),
		agentId: overrides?.agentId ?? '11111111-1111-1111-1111-111111111111',
		nonce: overrides?.nonce ?? randomBytes(16).toString('hex'),
		ts: overrides?.ts ?? Date.now(),
	}
	return encrypt(JSON.stringify(payload))
}

describe('GET /api/linkedin/callback', () => {
	beforeEach(() => {
		vi.mocked(unipile.findAccountByName).mockReset()
		vi.mocked(unipile.getAccountById).mockReset()
	})

	it('lands the account in syncing state and writes an audit event', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'SDR' })
		const nonce = randomBytes(16).toString('hex')

		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce({
			object: 'Account',
			id: 'unipile-acc-1',
			connection_params: { im: { username: 'sindre.brekke', provider_id: 'urn:li:person:abc' } },
		})

		const state = buildState({ workspaceId: ws.id, actorId, agentId: agent.id, nonce })
		const app = buildApp()
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain(`/${ws.id}/agents/${agent.id}`)
		expect(res.headers.get('location')).toContain('linkedin=connected')

		const [row] = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(row).toBeDefined()
		expect(row.state).toBe('syncing')
		expect(row.unipileAccountId).toBe('unipile-acc-1')
		expect(row.sendingAsName).toBe('sindre.brekke')
		expect(row.sendingAsProviderId).toBe('urn:li:person:abc')
		expect(row.connectedAt).toBeInstanceOf(Date)

		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'linkedin_account'), eq(events.entityId, row.id)))
		expect(event).toBeDefined()
		expect(event.action).toBe('created')
		expect(event.workspaceId).toBe(ws.id)
	})

	it('upserts a second successful connect on the same workspace instead of duplicating', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'SDR2' })

		vi.mocked(unipile.findAccountByName)
			.mockResolvedValueOnce({
				object: 'Account',
				id: 'unipile-acc-first',
				connection_params: { im: { username: 'first', provider_id: 'urn:1' } },
			})
			.mockResolvedValueOnce({
				object: 'Account',
				id: 'unipile-acc-second',
				connection_params: { im: { username: 'second', provider_id: 'urn:2' } },
			})

		const app = buildApp()
		await app.request(
			`/api/linkedin/callback?state=${encodeURIComponent(buildState({ workspaceId: ws.id, actorId, agentId: agent.id }))}`,
		)
		await app.request(
			`/api/linkedin/callback?state=${encodeURIComponent(buildState({ workspaceId: ws.id, actorId, agentId: agent.id }))}`,
		)

		const rows = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(rows).toHaveLength(1)
		expect(rows[0].unipileAccountId).toBe('unipile-acc-second')
		expect(rows[0].state).toBe('syncing')

		// The second callback is a state replay against an already-syncing row;
		// it must NOT re-emit `created` — only the first callback does.
		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'linkedin_account'), eq(events.entityId, rows[0].id)))
			.orderBy(asc(events.id))
		expect(audit.map((e) => e.action)).toEqual(['created', 'updated'])
	})

	it('logs `reconnected` when a restricted account transitions back to syncing', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'SDR-reconnect' })

		// Pre-seed a row in `restricted` — the shape T5's reconnect flow lands the
		// user in before they walk back through Unipile hosted-auth.
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'restricted',
			unipileAccountId: 'unipile-acc-old',
			sendingAsName: 'old',
			sendingAsProviderId: 'urn:old',
			createdBy: actorId,
		})

		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce({
			object: 'Account',
			id: 'unipile-acc-new',
			connection_params: { im: { username: 'new', provider_id: 'urn:new' } },
		})

		const state = buildState({ workspaceId: ws.id, actorId, agentId: agent.id })
		const app = buildApp()
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)
		expect(res.status).toBe(302)

		const [row] = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(row.state).toBe('syncing')

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'linkedin_account'), eq(events.entityId, row.id)))
		expect(audit).toHaveLength(1)
		expect(audit[0].action).toBe('reconnected')
		expect((audit[0].data as Record<string, unknown>).prior_state).toBe('restricted')
	})

	it('rejects the callback when the actor is no longer a workspace member', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const otherActor = await insertActor(db, { type: 'human', name: 'kicked-out' })

		// otherActor is NOT a member of ws — the callback should reject before
		// touching Unipile or the linkedin_accounts row.
		const state = buildState({ workspaceId: ws.id, actorId: otherActor.id, agentId: actorId })
		const app = buildApp()
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(400)
		const body = (await res.json()) as { message?: string; error?: string }
		expect(JSON.stringify(body).toLowerCase()).toContain('member')

		// No row, no audit event.
		const rows = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	it('redirects with linkedin=failed when Unipile bounces back with ?error=failed', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'SDR-failed' })

		const state = buildState({ workspaceId: ws.id, actorId, agentId: agent.id })
		const app = buildApp()
		const res = await app.request(
			`/api/linkedin/callback?state=${encodeURIComponent(state)}&error=failed`,
		)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain(`/${ws.id}/agents/${agent.id}`)
		expect(res.headers.get('location')).toContain('linkedin=failed')

		// Failure branch must not touch the account row or log a Unipile-account
		// event; the `handoff` placeholder (if any) is preserved for the retry.
		const rows = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
		const audit = await db.select().from(events).where(eq(events.entityType, 'linkedin_account'))
		expect(audit).toHaveLength(0)
		expect(unipile.findAccountByName).not.toHaveBeenCalled()
		expect(unipile.getAccountById).not.toHaveBeenCalled()
	})

	it('rejects an expired state param', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const state = buildState({
			workspaceId: ws.id,
			actorId,
			ts: Date.now() - 30 * 60 * 1000,
		})
		const app = buildApp()
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { message?: string; error?: string }
		expect(JSON.stringify(body).toLowerCase()).toContain('expired')
	})

	it('redirects with linkedin=not_found when Unipile has no record of the account', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'SDR3' })

		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce(null)
		vi.mocked(unipile.getAccountById).mockResolvedValueOnce(null)

		const state = buildState({ workspaceId: ws.id, actorId, agentId: agent.id })
		const app = buildApp()
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('linkedin=not_found')

		// The `handoff` row from POST /connect is NOT created here (this test skips
		// the connect step), so no row should exist and no event should be emitted.
		const rows = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})
})
