import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { PERSONAL_KEY_CAP, authMiddleware, hashApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { apiKeys } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: apiKeysRoutes } = await import('../../routes/api-keys')

/**
 * A person's own keys, on real Postgres with the auth cache ON (60s), the way production runs it.
 * Revoking has to take effect on the very next request, so the revoke test authenticates with the
 * key first (priming the cache) and then calls again after the revoke.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function createApp() {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.use('*', authMiddleware(db, { cacheTtlMs: 60_000 }))
	app.get('/whoami', (c) => c.json({ actorId: c.get('actorId') }))
	app.route('/api/account/api-keys', apiKeysRoutes)
	return app
}

const auth = (key: string, extra: Record<string, string> = {}) => ({
	Authorization: `Bearer ${key}`,
	...extra,
})

type App = ReturnType<typeof createApp>
type KeyRow = {
	id: string
	kind: string
	name: string | null
	hint: string
	last_used_at: string | null
	used_by: { type: string; name: string } | null
}

const list = async (app: App, key: string) => {
	const res = await app.request(jsonGet('/api/account/api-keys', auth(key)))
	expect(res.status).toBe(200)
	return ((await res.json()) as { keys: KeyRow[] }).keys
}

const create = (app: App, key: string, name: string, extra: Record<string, string> = {}) =>
	app.request(jsonRequest('POST', '/api/account/api-keys', { name }, auth(key, extra)))

describe('my API keys — real Postgres', () => {
	it('makes a named key, shows its secret once, and stores only the hash', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })

		const res = await create(app, person.apiKey, '  Claude Code on my laptop  ')
		expect(res.status).toBe(201)
		const { key, secret } = (await res.json()) as { key: KeyRow; secret: string }
		expect(secret).toMatch(/^ank_[0-9a-f]{32}$/)
		expect(key).toMatchObject({
			kind: 'personal',
			name: 'Claude Code on my laptop',
			hint: `ank_…${secret.slice(-4)}`,
			last_used_at: null,
			used_by: null,
		})

		const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id))
		expect(row).toMatchObject({
			actorId: person.id,
			kind: 'personal',
			name: 'Claude Code on my laptop',
			keyHash: hashApiKey(secret),
			last4: secret.slice(-4),
		})
		expect(JSON.stringify(row)).not.toContain(secret)

		const listed = await app.request(jsonGet('/api/account/api-keys', auth(person.apiKey)))
		expect(await listed.text()).not.toContain(secret)
	})

	it('lists only my own live keys, with last used and what holds each', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		const other = await insertActor(db, { type: 'human' })
		const { key: mine, secret } = (await (await create(app, person.apiKey, 'Mine')).json()) as {
			key: KeyRow
			secret: string
		}
		await create(app, other.apiKey, 'Theirs')

		// Using the key stamps last used.
		const whoami = await app.request(jsonGet('/whoami', auth(secret)))
		expect(whoami.status).toBe(200)

		const keys = await list(app, person.apiKey)
		expect(keys.map((k) => k.kind).sort()).toEqual(['personal', 'primary'])
		const primary = keys.find((k) => k.kind === 'primary')
		expect(primary).toMatchObject({
			name: null,
			used_by: { type: 'connection', name: 'Account key' },
		})
		const personal = keys.find((k) => k.id === mine.id)
		expect(personal?.name).toBe('Mine')
		expect(personal?.last_used_at).not.toBeNull()
		expect(keys.some((k) => k.name === 'Theirs')).toBe(false)
	})

	it('revokes a key and rejects it on the very next request, even though it was cached', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		const { key, secret } = (await (await create(app, person.apiKey, 'Short lived')).json()) as {
			key: KeyRow
			secret: string
		}
		expect((await app.request(jsonGet('/whoami', auth(secret)))).status).toBe(200)
		expect((await app.request(jsonGet('/whoami', auth(secret)))).status).toBe(200)

		const res = await app.request(
			jsonRequest('DELETE', `/api/account/api-keys/${key.id}`, undefined, auth(person.apiKey)),
		)
		expect(res.status).toBe(200)

		expect((await app.request(jsonGet('/whoami', auth(secret)))).status).toBe(401)
		expect((await list(app, person.apiKey)).some((k) => k.id === key.id)).toBe(false)
		const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id))
		expect(row?.revokedAt).not.toBeNull()

		// Revoking again finds nothing live.
		const again = await app.request(
			jsonRequest('DELETE', `/api/account/api-keys/${key.id}`, undefined, auth(person.apiKey)),
		)
		expect(again.status).toBe(404)
	})

	it("answers 404 for another person's key and leaves it working", async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		const other = await insertActor(db, { type: 'human' })
		const { key, secret } = (await (await create(app, other.apiKey, 'Theirs')).json()) as {
			key: KeyRow
			secret: string
		}
		expect((await app.request(jsonGet('/whoami', auth(secret)))).status).toBe(200)

		const res = await app.request(
			jsonRequest('DELETE', `/api/account/api-keys/${key.id}`, undefined, auth(person.apiKey)),
		)
		expect(res.status).toBe(404)
		const unknown = await app.request(
			jsonRequest(
				'DELETE',
				`/api/account/api-keys/${randomUUID()}`,
				undefined,
				auth(person.apiKey),
			),
		)
		expect(unknown.status).toBe(404)
		expect((await app.request(jsonGet('/whoami', auth(secret)))).status).toBe(200)
	})

	it('holds a person to the personal key limit, even under concurrent requests', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		await db.insert(apiKeys).values(
			Array.from({ length: PERSONAL_KEY_CAP - 2 }, (_, i) => ({
				actorId: person.id,
				keyHash: hashApiKey(`ank_${randomUUID()}`),
				last4: 'abcd',
				kind: 'personal' as const,
				name: `Existing ${i}`,
			})),
		)

		const results = await Promise.all(
			Array.from({ length: 5 }, (_, i) => create(app, person.apiKey, `Race ${i}`)),
		)
		expect(results.filter((r) => r.status === 201)).toHaveLength(2)
		expect(results.filter((r) => r.status === 409)).toHaveLength(3)

		const personal = await db
			.select({ id: apiKeys.id })
			.from(apiKeys)
			.where(and(eq(apiKeys.actorId, person.id), eq(apiKeys.kind, 'personal')))
		expect(personal).toHaveLength(PERSONAL_KEY_CAP)

		// Revoking one frees a place.
		const [first] = (await list(app, person.apiKey)).filter((k) => k.kind === 'personal')
		await app.request(
			jsonRequest('DELETE', `/api/account/api-keys/${first?.id}`, undefined, auth(person.apiKey)),
		)
		expect((await create(app, person.apiKey, 'One more')).status).toBe(201)
	})

	it('refuses a name that is empty, blank or too long', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		for (const name of ['', '   ', 'x'.repeat(61)]) {
			expect((await create(app, person.apiKey, name)).status).toBe(400)
		}
	})

	it('refuses an agent, and a call that comes in over MCP', async () => {
		const app = createApp()
		const person = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })

		expect((await create(app, agent.apiKey, 'Sneaky')).status).toBe(403)
		expect((await app.request(jsonGet('/api/account/api-keys', auth(agent.apiKey)))).status).toBe(
			403,
		)
		const viaMcp = await create(app, person.apiKey, 'From a model', { 'X-Client-Source': 'mcp' })
		expect(viaMcp.status).toBe(403)
		expect((await list(app, person.apiKey)).some((k) => k.kind === 'personal')).toBe(false)
	})

	it('only accepts the kinds the check constraint names', async () => {
		const person = await insertActor(db, { type: 'human' })
		const row = (kind: string) => ({
			actorId: person.id,
			keyHash: hashApiKey(`ank_${randomUUID()}`),
			last4: 'abcd',
			kind: kind as 'personal',
		})
		await expect(db.insert(apiKeys).values(row('personal'))).resolves.toBeDefined()
		await expect(db.insert(apiKeys).values(row('bogus'))).rejects.toThrow()
	})
})
