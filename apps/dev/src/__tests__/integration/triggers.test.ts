import { sessions, triggers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	buildCreateTriggerBody,
	insertActor,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: triggersRoutes } = await import('../../routes/triggers')

function createApp() {
	return createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
}

describe('Triggers Integration', () => {
	let workspaceId: string
	let targetActorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Test Agent' })
		targetActorId = agent.id
	})

	describe('CRUD lifecycle', () => {
		it('creates, lists, updates, and deletes a trigger', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ target_actor_id: targetActorId }),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.enabled).toBe(true)
			expect(created.config.entity_type).toBe('task')

			// List
			const listRes = await app.request(jsonGet('/api/triggers', headers))
			expect(listRes.status).toBe(200)
			const list = await listRes.json()
			expect(list.length).toBeGreaterThanOrEqual(1)

			// Update (disable)
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/triggers/${created.id}`, { enabled: false }, headers),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.enabled).toBe(false)

			// Update action_prompt and confirm it persists
			const newPrompt = 'Updated action prompt for test'
			const promptUpdateRes = await app.request(
				jsonRequest('PATCH', `/api/triggers/${created.id}`, { action_prompt: newPrompt }, headers),
			)
			expect(promptUpdateRes.status).toBe(200)
			const promptUpdated = await promptUpdateRes.json()
			expect(promptUpdated.actionPrompt).toBe(newPrompt)

			// Verify persisted: re-read the trigger and confirm actionPrompt matches
			const [persisted] = await db
				.select()
				.from(triggers)
				.where(eq(triggers.id, created.id))
				.limit(1)
			expect(persisted.actionPrompt).toBe(newPrompt)

			// Delete
			const deleteRes = await app.request(
				jsonRequest('DELETE', `/api/triggers/${created.id}`, undefined, headers),
			)
			expect(deleteRes.status).toBe(200)

			// Verify deleted - list should be empty
			const listAfterRes = await app.request(jsonGet('/api/triggers', headers))
			const listAfter = await listAfterRes.json()
			expect(listAfter.find((t: { id: string }) => t.id === created.id)).toBeUndefined()
		})
	})

	describe('delete with linked sessions', () => {
		it('nulls out sessions.trigger_id and deletes the trigger', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const actorId = getTestActorId()

			const trigger = await insertTrigger(db, workspaceId, actorId, targetActorId)
			const session = await insertSession(db, workspaceId, targetActorId, actorId, {
				triggerId: trigger.id,
			})

			const deleteRes = await app.request(
				jsonRequest('DELETE', `/api/triggers/${trigger.id}`, undefined, headers),
			)
			expect(deleteRes.status).toBe(200)

			const remainingTriggers = await db.select().from(triggers).where(eq(triggers.id, trigger.id))
			expect(remainingTriggers).toHaveLength(0)

			const [updatedSession] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(updatedSession).toBeDefined()
			expect(updatedSession.triggerId).toBeNull()
		})
	})

	describe('event matching config', () => {
		it('stores trigger with complex event config', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({
						target_actor_id: targetActorId,
						config: {
							entity_type: 'task',
							action: 'updated',
							from_status: 'todo',
							to_status: 'in_progress',
						},
					}),
					headers,
				),
			)

			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.config.from_status).toBe('todo')
			expect(created.config.to_status).toBe('in_progress')
		})
	})
})
