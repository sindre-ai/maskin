import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

function buildApiKeyProvider(name: string): ResolvedProvider {
	return {
		config: {
			name,
			displayName: `Test API Key Provider ${name}`,
			auth: {
				type: 'api_key',
				config: { headerName: 'Authorization', envKeyName: 'TEST_API_KEY' },
			},
		},
	} as unknown as ResolvedProvider
}

function connectRequest(provider: string, workspaceId: string, body: unknown) {
	return new Request(`http://localhost/api/integrations/${provider}/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

// The unique index backing this upsert is PARTIAL
// (`integrations_ws_provider_external_uniq ... WHERE external_id IS NOT NULL`),
// so Postgres rejects an ON CONFLICT target that omits the same predicate with
// `42P10: there is no unique or exclusion constraint matching the ON CONFLICT
// specification`. Only a real-Postgres test can catch that — the mocked route
// tests never render the SQL. Regression coverage for MASKIN-DEV-C.
describe('POST /api/integrations/:provider/connect — api_key providers', () => {
	it('activates the integration and upserts against the partial unique index on reconnect', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const providerName = `test-api-key-provider-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue(buildApiKeyProvider(providerName))

		const app = buildApp()

		const first = await app.request(connectRequest(providerName, ws.id, { api_key: 'key-one' }))
		expect(first.status).toBe(200)

		// Same workspace + provider + external_id — this is the ON CONFLICT path.
		const second = await app.request(connectRequest(providerName, ws.id, { api_key: 'key-two' }))
		expect(second.status).toBe(200)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, providerName)))

		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe(`${providerName}-personal`)
	})

	it('returns 400 when the api_key is missing from the request body', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const providerName = `test-api-key-provider-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue(buildApiKeyProvider(providerName))

		const res = await buildApp().request(connectRequest(providerName, ws.id, {}))
		expect(res.status).toBe(400)
	})
})
