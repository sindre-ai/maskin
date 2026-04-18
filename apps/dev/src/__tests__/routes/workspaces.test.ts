import { randomUUID } from 'node:crypto'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import { type ModuleDefinition, clearModules, registerModule } from '@maskin/module-sdk'
import { buildCreateWorkspaceBody, buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp, createTestContext } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

function makeModule(id: string, overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
	return {
		id,
		name: id,
		version: '0.0.0',
		objectTypes: [],
		...overrides,
	}
}

describe('Workspaces Routes', () => {
	describe('POST /api/workspaces', () => {
		it('creates a workspace and returns 201', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insert = [ws]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(ws.id)
			expect(body.name).toBe(ws.name)
		})

		it('returns 500 when insert returns empty', async () => {
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('Failed to create workspace')
		})
	})

	describe('GET /api/workspaces', () => {
		it('returns 200 with list of workspaces', async () => {
			const ws = { ...buildWorkspace(), role: 'owner' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [ws]

			const res = await app.request(jsonGet('/api/workspaces'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})
	})

	describe('PATCH /api/workspaces/:id', () => {
		it('returns 200 when workspace updated', async () => {
			const ws = buildWorkspace()
			const updated = { ...ws, name: 'Updated Workspace' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, { name: 'Updated Workspace' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when workspace not found for settings merge', async () => {
			const { app } = createTestApp(workspacesRoutes, '/api/workspaces')
			const id = '00000000-0000-0000-0000-000000000099'

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/workspaces/:id — enabled_modules lifecycle hooks', () => {
		afterEach(() => {
			clearModules()
		})

		function setupAppWithEnv() {
			const app = new CreateOpenAPIHono()
			const { db, mockResults } = createTestContext()
			app.use('*', async (c, next) => {
				c.set('db', db)
				c.set('actorId', 'test-actor-id')
				c.set('actorType', 'human')
				c.set('notifyBridge', {})
				c.set('sessionManager', {})
				c.set('agentStorage', {})
				c.set('storageProvider', {})
				await next()
			})
			app.route('/api/workspaces', workspacesRoutes)
			return { app, mockResults }
		}

		it('invokes onEnable for newly added modules', async () => {
			const onEnable = vi.fn().mockResolvedValue(undefined)
			const onDisable = vi.fn().mockResolvedValue(undefined)
			registerModule(makeModule('notetaker', { onEnable, onDisable }))

			const existing = buildWorkspace({
				settings: { enabled_modules: ['work'] },
			})
			const updated = {
				...existing,
				settings: { enabled_modules: ['work', 'notetaker'] },
			}
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { enabled_modules: ['work', 'notetaker'] },
				}),
			)

			expect(res.status).toBe(200)
			expect(onEnable).toHaveBeenCalledTimes(1)
			expect(onEnable).toHaveBeenCalledWith(
				expect.objectContaining({ db: expect.anything() }),
				expect.objectContaining({ workspaceId: existing.id, actorId: 'test-actor-id' }),
			)
			expect(onDisable).not.toHaveBeenCalled()
		})

		it('invokes onDisable for removed modules', async () => {
			const onEnable = vi.fn().mockResolvedValue(undefined)
			const onDisable = vi.fn().mockResolvedValue(undefined)
			registerModule(makeModule('notetaker', { onEnable, onDisable }))

			const existing = buildWorkspace({
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const updated = {
				...existing,
				settings: { enabled_modules: ['work'] },
			}
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { enabled_modules: ['work'] },
				}),
			)

			expect(res.status).toBe(200)
			expect(onDisable).toHaveBeenCalledTimes(1)
			expect(onDisable).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ workspaceId: existing.id, actorId: 'test-actor-id' }),
			)
			expect(onEnable).not.toHaveBeenCalled()
		})

		it('is a no-op when enabled_modules is unchanged', async () => {
			const onEnable = vi.fn().mockResolvedValue(undefined)
			const onDisable = vi.fn().mockResolvedValue(undefined)
			registerModule(makeModule('notetaker', { onEnable, onDisable }))

			const existing = buildWorkspace({
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [existing]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { enabled_modules: ['work', 'notetaker'] },
				}),
			)

			expect(res.status).toBe(200)
			expect(onEnable).not.toHaveBeenCalled()
			expect(onDisable).not.toHaveBeenCalled()
		})

		it('does not invoke hooks when settings update does not touch enabled_modules', async () => {
			const onEnable = vi.fn().mockResolvedValue(undefined)
			const onDisable = vi.fn().mockResolvedValue(undefined)
			registerModule(makeModule('notetaker', { onEnable, onDisable }))

			const existing = buildWorkspace({
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [existing]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(200)
			expect(onEnable).not.toHaveBeenCalled()
			expect(onDisable).not.toHaveBeenCalled()
		})

		it('does not fail the PATCH when onEnable throws', async () => {
			const onEnable = vi.fn().mockRejectedValue(new Error('boom'))
			registerModule(makeModule('notetaker', { onEnable }))

			const existing = buildWorkspace({
				settings: { enabled_modules: ['work'] },
			})
			const updated = {
				...existing,
				settings: { enabled_modules: ['work', 'notetaker'] },
			}
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { enabled_modules: ['work', 'notetaker'] },
				}),
			)

			expect(res.status).toBe(200)
			expect(onEnable).toHaveBeenCalledTimes(1)
		})

		it('skips modules that have no hooks', async () => {
			registerModule(makeModule('hookless')) // no onEnable/onDisable

			const existing = buildWorkspace({ settings: { enabled_modules: ['work'] } })
			const updated = { ...existing, settings: { enabled_modules: ['work', 'hookless'] } }
			const { app, mockResults } = setupAppWithEnv()
			mockResults.select = [existing]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${existing.id}`, {
					settings: { enabled_modules: ['work', 'hookless'] },
				}),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('POST /api/workspaces/:id/members', () => {
		it('adds a member and returns 201', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${wsId}/members`, {
					actor_id: actorId,
					role: 'member',
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.added).toBe(true)
		})
	})

	describe('GET /api/workspaces/:id/members', () => {
		it('returns 200 with list of members', async () => {
			const wsId = randomUUID()
			const member = {
				actorId: randomUUID(),
				role: 'owner',
				joinedAt: new Date(),
				name: 'Alice',
				type: 'human',
			}
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [member]

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/members`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].role).toBe('owner')
		})
	})
})
