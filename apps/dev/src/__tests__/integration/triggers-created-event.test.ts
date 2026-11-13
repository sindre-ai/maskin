import { workspaceMembers } from '@maskin/db/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCreateTriggerBody, insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: capturePosthogEventMock,
}))

const { default: triggersRoutes } = await import('../../routes/triggers')

describe('Triggers: POST / emits trigger_created', () => {
	let workspaceId: string
	let targetActorId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Test Agent' })
		targetActorId = agent.id
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: targetActorId, role: 'member' })
	})

	it('sends one trigger_created with the ids and kind, and no name or prompt', async () => {
		const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/triggers',
				buildCreateTriggerBody({ target_actor_id: targetActorId }),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		const created = await res.json()

		const calls = capturePosthogEventMock.mock.calls.filter(
			([event]) => event === 'trigger_created',
		)
		expect(calls).toHaveLength(1)
		expect(calls[0][1]).toBe(getTestActorId())
		expect(calls[0][2]).toMatchObject({
			workspace_id: workspaceId,
			entity_id: created.id,
			entity_type: 'trigger',
			trigger_type: created.type,
		})
		expect(JSON.stringify(calls[0][2])).not.toContain(created.name)
	})
})
