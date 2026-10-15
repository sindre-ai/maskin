import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

function request(method: string, path: string, workspaceId: string, body?: unknown) {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

describe('integration expose_to_agent_sessions setting', () => {
	it('is stored at connect, shown by the list route, flipped by PATCH, and keeps the rest of config', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const app = buildApp()

		const connect = await app.request(
			request('POST', '/api/integrations/resend/connect', ws.id, {
				expose_to_agent_sessions: false,
			}),
		)
		expect(connect.status).toBe(200)
		const { integration_id: id } = (await connect.json()) as { integration_id: string }

		const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
		const connectedConfig = row?.config as Record<string, unknown>
		expect(connectedConfig.expose_to_agent_sessions).toBe(false)
		expect(typeof connectedConfig.system_actor_id).toBe('string')

		const listed = (await (
			await app.request(request('GET', '/api/integrations', ws.id))
		).json()) as Array<{ id: string; config: Record<string, unknown> }>
		expect(listed.find((i) => i.id === id)?.config.expose_to_agent_sessions).toBe(false)

		const patch = await app.request(
			request('PATCH', `/api/integrations/${id}`, ws.id, { expose_to_agent_sessions: true }),
		)
		expect(patch.status).toBe(200)
		const patched = (await patch.json()) as Record<string, unknown>
		expect(patched).not.toHaveProperty('credentials')

		const [after] = await db.select().from(integrations).where(eq(integrations.id, id))
		expect(after?.config).toEqual({ ...connectedConfig, expose_to_agent_sessions: true })
	})

	it('404s a PATCH from a different workspace', async () => {
		const actorId = getTestActorId()
		const owner = await insertWorkspace(db, actorId)
		const other = await insertWorkspace(db, actorId)
		const app = buildApp()

		const connect = await app.request(request('POST', '/api/integrations/resend/connect', owner.id))
		const { integration_id: id } = (await connect.json()) as { integration_id: string }

		const res = await app.request(
			request('PATCH', `/api/integrations/${id}`, other.id, { expose_to_agent_sessions: false }),
		)
		expect(res.status).toBe(404)
	})
})
