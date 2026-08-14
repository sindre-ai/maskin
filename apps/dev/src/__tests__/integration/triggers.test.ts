import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, sessions, triggers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import {
	buildCreateTriggerBody,
	insertActor,
	insertObject,
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

	describe('updating type', () => {
		it('persists a type change alongside its matching config', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Seed as a cron placeholder, mirroring how CreatePicker creates new triggers.
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({
						target_actor_id: targetActorId,
						type: 'cron',
						config: { expression: '0 0 * * *' },
					}),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()

			// User reconfigures it to an event trigger via the detail-page form.
			const updateRes = await app.request(
				jsonRequest(
					'PATCH',
					`/api/triggers/${created.id}`,
					{ type: 'event', config: { entity_type: 'meeting', action: 'created' } },
					headers,
				),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.type).toBe('event')
			expect(updated.config.entity_type).toBe('meeting')
			expect(updated.config.action).toBe('created')

			// Refetch to confirm it was actually persisted, not just echoed back.
			const listRes = await app.request(jsonGet('/api/triggers', headers))
			const list = await listRes.json()
			const refetched = list.find((t: { id: string }) => t.id === created.id)
			expect(refetched.type).toBe('event')
			expect(refetched.config.entity_type).toBe('meeting')
		})

		it('rejects a type change without a matching config', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({
						target_actor_id: targetActorId,
						type: 'cron',
						config: { expression: '0 0 * * *' },
					}),
					headers,
				),
			)
			const created = await createRes.json()

			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/triggers/${created.id}`, { type: 'event' }, headers),
			)
			expect(updateRes.status).toBe(400)
		})

		it('leaves type unchanged when the update omits it', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ target_actor_id: targetActorId }),
					headers,
				),
			)
			const created = await createRes.json()
			expect(created.type).toBe('event')

			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/triggers/${created.id}`, { enabled: false }, headers),
			)
			const updated = await updateRes.json()
			expect(updated.type).toBe('event')
			expect(updated.enabled).toBe(false)
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

	// Loop steps are event triggers, and loops can flow objects of ANY
	// workspace-defined type. The runner used to gate objects-table hydration
	// behind a hardcoded ['bet','task','insight'] allow-list, so a filter like
	// { status: ... } on a custom type never matched. These tests run the real
	// TriggerRunner against real Postgres to pin the dynamic behavior.
	describe('event trigger firing for custom object types (TriggerRunner)', () => {
		async function runEventThroughRunner(opts: {
			objectStatus: string
			filter: Record<string, unknown>
		}) {
			// A custom-typed object — 'lead' appears in no hardcoded type list.
			const lead = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'lead',
				title: 'Acme Corp',
				status: opts.objectStatus,
			})
			const trigger = await insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
				type: 'event',
				config: { entity_type: 'lead', action: 'status_changed', filter: opts.filter },
				enabled: true,
			})
			// New {changes}-shape event: no previous/updated snapshot, so the
			// runner must hydrate the current row from the objects table.
			const [eventRow] = await db
				.insert(events)
				.values({
					workspaceId,
					actorId: getTestActorId(),
					action: 'status_changed',
					entityType: 'lead',
					entityId: lead?.id,
					data: { changes: [{ field: 'status', old: 'new', new: opts.objectStatus }] },
				})
				.returning()

			const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
			const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
			const runner = new TriggerRunner(db, bridge, {
				createSession,
			} as unknown as SessionManager)
			await runner.start()
			try {
				bridge.emit('event', {
					workspace_id: workspaceId,
					entity_type: 'lead',
					entity_id: lead?.id,
					action: 'status_changed',
					actor_id: getTestActorId(),
					event_id: String(eventRow?.id),
				})
				// handleEvent runs fire-and-forget off the bridge listener — poll
				// briefly instead of asserting on a race.
				const deadline = Date.now() + 3000
				while (createSession.mock.calls.length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			} finally {
				await runner.stop()
			}
			return { createSession, trigger }
		}

		it('fires a status_changed trigger for a custom object type by hydrating the row from Postgres', async () => {
			const { createSession, trigger } = await runEventThroughRunner({
				objectStatus: 'qualified',
				filter: { status: 'qualified' },
			})
			expect(createSession).toHaveBeenCalledTimes(1)
			const [, sessionArgs] = createSession.mock.calls[0] as [
				string,
				{ actorId: string; triggerId: string },
			]
			expect(sessionArgs.actorId).toBe(targetActorId)
			expect(sessionArgs.triggerId).toBe(trigger?.id)
		})

		it('does not fire when the hydrated custom-type row fails the filter', async () => {
			const { createSession } = await runEventThroughRunner({
				objectStatus: 'new',
				filter: { status: 'qualified' },
			})
			expect(createSession).not.toHaveBeenCalled()
		})
	})
})
