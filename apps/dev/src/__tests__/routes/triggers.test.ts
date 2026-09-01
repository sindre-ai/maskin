import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { buildCreateTriggerBody, buildTrigger, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { runSlackTriggerSetupMock } = vi.hoisted(() => ({
	runSlackTriggerSetupMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/slack-trigger-setup', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/slack-trigger-setup')>()
	return {
		...actual,
		runSlackTriggerSetup: runSlackTriggerSetupMock,
	}
})

const { default: triggersRoutes } = await import('../../routes/triggers')

const wsId = '00000000-0000-0000-0000-000000000001'
const testerActorId = 'test-actor-id'

// The route reads its flag via `isFlagEnabled(actorId, 'slack-setup-ux-v2')`,
// which resolves against `FF_TESTER_ACTOR_IDS` × `FF_TESTER_FEATURES`. Turn
// both on for the test actor so the post-commit hook actually fires — a fresh
// `_resetFeatureFlagConfig()` re-reads the env after every mutation.
beforeAll(() => {
	process.env.FF_TESTER_ACTOR_IDS = testerActorId
	process.env.FF_TESTER_FEATURES = 'slack-setup-ux-v2'
	_resetFeatureFlagConfig()
})

beforeEach(() => {
	runSlackTriggerSetupMock.mockClear()
})

afterEach(() => {
	_resetFeatureFlagConfig()
})

describe('Triggers Routes', () => {
	describe('POST /api/triggers', () => {
		it('creates a trigger and returns 201', async () => {
			const trigger = buildTrigger({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.insert = [trigger]

			const res = await app.request(
				jsonRequest('POST', '/api/triggers', buildCreateTriggerBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(trigger.id)
			expect(body.name).toBe(trigger.name)
			expect(body.enabled).toBe(true)
		})

		it('returns 400 for invalid cron expression', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ type: 'cron', config: { expression: 'not-valid' } }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('fires runSlackTriggerSetup post-commit for a Slack event trigger with channel_ids', async () => {
			const config = {
				entity_type: 'slack.channel_message',
				action: 'created',
				conditions: [{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] }],
			}
			const trigger = buildTrigger({
				workspaceId: wsId,
				type: 'event',
				name: 'Sales alerts',
				config,
			})
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.insert = [trigger]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ type: 'event', name: 'Sales alerts', config }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(runSlackTriggerSetupMock).toHaveBeenCalledTimes(1)
			expect(runSlackTriggerSetupMock).toHaveBeenCalledWith(expect.anything(), {
				triggerId: trigger.id,
				workspaceId: wsId,
				channelIds: ['C1', 'C2'],
				triggerName: 'Sales alerts',
				actorId: testerActorId,
			})
		})

		it('does not fire the setup service for a non-Slack trigger', async () => {
			const trigger = buildTrigger({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.insert = [trigger]

			const res = await app.request(
				jsonRequest('POST', '/api/triggers', buildCreateTriggerBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			expect(runSlackTriggerSetupMock).not.toHaveBeenCalled()
		})
	})

	describe('GET /api/triggers', () => {
		it('returns 200 with list of triggers and X-Total-Count matching row count when unpaginated', async () => {
			const t1 = buildTrigger({ workspaceId: wsId })
			const t2 = buildTrigger({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.select = [t1, t2]

			const res = await app.request(jsonGet('/api/triggers', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			expect(res.headers.get('x-total-count')).toBe('2')
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('surfaces total trigger count beyond the page cap when limit is set', async () => {
			const page = [buildTrigger({ workspaceId: wsId })]
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [page, [{ value: 250 }]]

			const res = await app.request(
				jsonGet('/api/triggers?limit=1&offset=0', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			expect(res.headers.get('x-total-count')).toBe('250')
			const body = await res.json()
			expect(body).toHaveLength(1)
		})

		it('rejects oversized limit query at the boundary', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(jsonGet('/api/triggers?limit=999', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(400)
		})
	})

	describe('PATCH /api/triggers/:id', () => {
		it('returns 200 when trigger updated', async () => {
			const trigger = buildTrigger()
			const updated = { ...trigger, name: 'Updated Trigger' }
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [[trigger], [buildWorkspaceMember()]]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/triggers/${trigger.id}`, { name: 'Updated Trigger' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when trigger not found', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(
				jsonRequest('PATCH', '/api/triggers/00000000-0000-0000-0000-000000000099', {
					name: 'Nope',
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for invalid cron expression on cron trigger', async () => {
			const trigger = buildTrigger({ type: 'cron', config: { expression: '*/5 * * * *' } })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [[trigger], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/triggers/${trigger.id}`, {
					config: { expression: 'bad' },
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('fires runSlackTriggerSetup post-commit when a Slack trigger is updated', async () => {
			const config = {
				entity_type: 'slack.channel_message',
				action: 'created',
				conditions: [{ field: 'event.channel', operator: 'in', value: ['CNEW'] }],
			}
			const trigger = buildTrigger({ workspaceId: wsId, type: 'event', name: 'Alerts', config })
			const updated = { ...trigger, config }
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [[trigger], [buildWorkspaceMember()]]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/triggers/${trigger.id}`, {
					type: 'event',
					config,
				}),
			)

			expect(res.status).toBe(200)
			expect(runSlackTriggerSetupMock).toHaveBeenCalledTimes(1)
			expect(runSlackTriggerSetupMock).toHaveBeenCalledWith(expect.anything(), {
				triggerId: trigger.id,
				workspaceId: trigger.workspaceId,
				channelIds: ['CNEW'],
				triggerName: 'Alerts',
				actorId: testerActorId,
			})
		})
	})

	describe('DELETE /api/triggers/:id', () => {
		it('returns 200 when deleted', async () => {
			const trigger = buildTrigger()
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [[trigger], [buildWorkspaceMember()]]

			const res = await app.request(jsonDelete(`/api/triggers/${trigger.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when trigger not found', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(
				jsonDelete('/api/triggers/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('Workspace membership enforcement', () => {
		it('PATCH /:id returns 404 when actor is not a workspace member', async () => {
			const trigger = buildTrigger()
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			// Trigger found, but membership check returns empty
			mockResults.selectQueue = [[trigger], []]

			const res = await app.request(
				jsonRequest('PATCH', `/api/triggers/${trigger.id}`, { name: 'Updated' }),
			)
			expect(res.status).toBe(404)
		})

		it('DELETE /:id returns 404 when actor is not a workspace member', async () => {
			const trigger = buildTrigger()
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			// Trigger found, but membership check returns empty
			mockResults.selectQueue = [[trigger], []]

			const res = await app.request(jsonDelete(`/api/triggers/${trigger.id}`))
			expect(res.status).toBe(404)
		})
	})
})
