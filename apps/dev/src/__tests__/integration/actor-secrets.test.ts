import { workspaceMembers } from '@maskin/db/schema'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: workspacesRoutes } = await import('../../routes/workspaces')

const SECRET_HASH = 'argon2id$integration-secret-hash'

// Every route that serialises an actors row, against real Postgres so the
// actual column selection is what's under test (mocked DBs return whatever the
// test hands them and can't see an over-wide select).
function expectNoSecrets(text: string, { allowApiKey = false } = {}) {
	expect(text).not.toContain(SECRET_HASH)
	expect(text).not.toMatch(/passwordHash|password_hash/)
	expect(text).not.toMatch(/"apiKey"/)
	if (!allowApiKey) expect(text).not.toMatch(/"api_key"|ank_/)
}

describe('actor routes never expose password hashes or api keys', () => {
	const app = createIntegrationApp(
		{ path: '/api/actors', module: actorsRoutes },
		{ path: '/api/workspaces', module: workspacesRoutes },
	)

	it('POST /api/actors (signup) returns the new key but no hash', async () => {
		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Secrets Signup',
				email: `secrets-${Date.now()}@test.com`,
				password: 'a-very-long-password-123',
			}),
		)
		expect(res.status).toBe(201)
		const text = await res.text()
		expect(text).not.toMatch(/passwordHash|password_hash|"apiKey"/)
		expect(text).not.toContain('$argon2')
		expect(JSON.parse(text).api_key).toMatch(/^ank_/)
	})

	it('GET list, GET /:id, PATCH and workspace members expose neither', async () => {
		const target = await insertActor(db, { passwordHash: SECRET_HASH, name: 'Target' })
		const ws = await insertWorkspace(db, getTestActorId())
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: target.id, role: 'member' })

		const list = await app.request(jsonGet('/api/actors', { 'X-Workspace-Id': ws.id }))
		expect(list.status).toBe(200)
		const listText = await list.text()
		expect(listText).toContain('Target')
		expectNoSecrets(listText)

		const one = await app.request(jsonGet(`/api/actors/${target.id}`))
		expect(one.status).toBe(200)
		expectNoSecrets(await one.text())

		const members = await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
		expect(members.status).toBe(200)
		expectNoSecrets(await members.text())

		const patched = await app.request(
			jsonRequest('PATCH', `/api/actors/${getTestActorId()}`, { description: 'hi' }),
		)
		expect(patched.status).toBe(200)
		expectNoSecrets(await patched.text())
	})

	it('POST /:id/api-keys returns only the new key', async () => {
		const target = await insertActor(db, { passwordHash: SECRET_HASH })
		const res = await app.request(jsonRequest('POST', `/api/actors/${target.id}/api-keys`))
		const text = await res.text()
		expect(Object.keys(JSON.parse(text))).toEqual(['api_key'])
		expect(text).not.toContain(SECRET_HASH)
	})
})
