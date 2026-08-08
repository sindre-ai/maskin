import { randomUUID } from 'node:crypto'
import { events, actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db } from './global-setup'

// Integration coverage for POST /api/vaerksted-auth/link — the M5 "Continue
// with vaerksted" exchange (vaerksted-auth-and-sync.md §8). vaerksted-auth's
// own GET /sessions/me is mocked at the global fetch boundary (same
// convention as slack-account-link.test.ts / slack-reconnect.test.ts) since
// this test suite can't reach a live Supabase-backed vaerksted-auth instance.
// Covers all three branches: brand-new actor, link-by-email, and
// already-linked (login).

const { default: vaerkstedAuthRoutes } = await import('../../routes/vaerksted-auth')

const TEST_BASE_URL = 'http://vaerksted-auth.test'
let originalBaseUrl: string | undefined

beforeAll(() => {
	originalBaseUrl = process.env.VAERKSTED_AUTH_BASE_URL
	process.env.VAERKSTED_AUTH_BASE_URL = TEST_BASE_URL
})

afterAll(() => {
	if (originalBaseUrl === undefined) {
		Reflect.deleteProperty(process.env, 'VAERKSTED_AUTH_BASE_URL')
	} else {
		process.env.VAERKSTED_AUTH_BASE_URL = originalBaseUrl
	}
})

beforeEach(() => {
	vi.restoreAllMocks()
})

function createApp() {
	return createIntegrationApp({ path: '/api/vaerksted-auth', module: vaerkstedAuthRoutes })
}

/** Mocks vaerksted-auth's GET /sessions/me to return a verified identity. */
function mockSessionsMe(
	result: { identity_id: string; email: string | null } | { status: number },
) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (!url.endsWith('/sessions/me')) {
			throw new Error(`unexpected fetch in test: ${url}`)
		}
		if ('status' in result) {
			return { ok: false, status: result.status, json: async () => ({}) } as unknown as Response
		}
		return { ok: true, status: 200, json: async () => result } as unknown as Response
	})
}

function postLink(app: ReturnType<typeof createApp>, token = 'session-token') {
	return app.request(jsonRequest('POST', '/api/vaerksted-auth/link', { session_token: token }))
}

describe('POST /api/vaerksted-auth/link', () => {
	it('returns 401 without ever touching the DB when vaerksted-auth rejects the token', async () => {
		mockSessionsMe({ status: 401 })
		const app = createApp()

		const res = await postLink(app, 'bad-token')
		expect(res.status).toBe(401)
	})

	it('returns 401 when vaerksted-auth is unreachable', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			throw new Error('ECONNREFUSED')
		})
		const app = createApp()

		const res = await postLink(app)
		expect(res.status).toBe(401)
	})

	it('creates a brand-new actor when no actor matches the identity or email', async () => {
		const identityId = randomUUID()
		const email = `new-${identityId}@vaerksted.test`
		mockSessionsMe({ identity_id: identityId, email })
		const app = createApp()

		const res = await postLink(app)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.email).toBe(email)
		expect(typeof body.api_key).toBe('string')
		expect(body.api_key.startsWith('ank_')).toBe(true)

		const [row] = await db.select().from(actors).where(eq(actors.id, body.id))
		expect(row).toBeDefined()
		expect(row.vaerkstedIdentityId).toBe(identityId)
		expect(row.passwordHash).toBeNull()
		expect(row.type).toBe('human')
		expect(row.apiKey).toBe(body.api_key)
	})

	it('links an existing native-password actor found by email, and logs an events row', async () => {
		const identityId = randomUUID()
		const existing = await insertActor(db, {
			email: `claim-${identityId}@vaerksted.test`,
			passwordHash: 'not-a-real-hash',
		})
		const ws = await insertWorkspace(db, existing.id)
		mockSessionsMe({ identity_id: identityId, email: existing.email })
		const app = createApp()

		const res = await postLink(app)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(existing.id)
		expect(body.api_key).toBe(existing.apiKey)

		const [row] = await db.select().from(actors).where(eq(actors.id, existing.id))
		expect(row.vaerkstedIdentityId).toBe(identityId)
		// password_hash is untouched by this route — linking never migrates it.
		expect(row.passwordHash).toBe('not-a-real-hash')

		const [event] = await db
			.select()
			.from(events)
			.where(eq(events.entityId, existing.id))
			.orderBy(events.id)
		expect(event).toBeDefined()
		expect(event.action).toBe('vaerksted_linked')
		expect(event.entityType).toBe('actor')
		expect(event.workspaceId).toBe(ws.id)
	})

	it('logs in an actor already linked to the identity without creating a new one or rotating the key', async () => {
		const identityId = randomUUID()
		const existing = await insertActor(db, {
			email: `already-${identityId}@vaerksted.test`,
			vaerkstedIdentityId: identityId,
		})
		mockSessionsMe({ identity_id: identityId, email: existing.email })
		const app = createApp()

		const res = await postLink(app)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(existing.id)
		expect(body.api_key).toBe(existing.apiKey)

		const rows = await db.select().from(actors).where(eq(actors.vaerkstedIdentityId, identityId))
		expect(rows).toHaveLength(1)
	})

	it('prefers the identity match over an email match when both exist', async () => {
		const identityId = randomUUID()
		const email = `shared-${identityId}@vaerksted.test`
		const linkedActor = await insertActor(db, {
			email: `other-${identityId}@vaerksted.test`,
			vaerkstedIdentityId: identityId,
		})
		// A different actor happens to share the email vaerksted-auth reports —
		// the identity match must win, and this actor must be left untouched.
		const emailActor = await insertActor(db, { email })
		mockSessionsMe({ identity_id: identityId, email })
		const app = createApp()

		const res = await postLink(app)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(linkedActor.id)

		const [untouched] = await db.select().from(actors).where(eq(actors.id, emailActor.id))
		expect(untouched.vaerkstedIdentityId).toBeNull()
	})
})
