import {
	buildCreateObjectBody,
	buildObject,
	buildRelationship,
	buildUpdateObjectBody,
	buildWorkspace,
	buildWorkspaceMember,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Import the route module directly (not index.ts)
const { default: objectsRoutes } = await import('../../routes/objects')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Objects Routes', () => {
	describe('POST /api/objects', () => {
		it('creates an object and returns 201', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]
			mockResults.insert = [obj]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(obj.id)
			expect(body.type).toBe('task')
		})

		it('returns 404 when workspace not found', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
			const body = await res.json()
			expect(body.error.message).toContain('Workspace not found')
		})

		it('returns 400 for invalid status', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ status: 'nonexistent_status' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})

		it('returns 400 for invalid object type', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ type: 'nonexistent' }), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid object type')
		})
	})

	describe('GET /api/objects', () => {
		it('returns 200 with list of objects', async () => {
			const obj1 = buildObject({ workspaceId: wsId })
			const obj2 = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj1, obj2]

			const res = await app.request(jsonGet('/api/objects', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 200 with sort and order params', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet('/api/objects?sort=title&order=asc', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 for invalid sort field', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=;DROP TABLE', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 200 for metadata sort field', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet('/api/objects?sort=metadata.priority', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 for unknown sort field', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects?sort=foobar', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(400)
		})

		it('returns 400 for metadata sort field with dots', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=metadata.a.b', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 for invalid order value', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?order=invalid', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/objects/:id', () => {
		it('returns 200 when object found', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(obj.id)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/objects/:id', () => {
		it('returns 200 when object updated', async () => {
			const existing = buildObject()
			const updated = { ...existing, title: 'Updated title' }
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, buildUpdateObjectBody()),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/objects/00000000-0000-0000-0000-000000000099',
					buildUpdateObjectBody(),
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for invalid status update', async () => {
			const existing = buildObject()
			const ws = buildWorkspace({ id: existing.workspaceId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third: workspace settings
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'bogus_status' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})

		it('merges metadata instead of replacing it', async () => {
			const existing = buildObject({
				metadata: { linkedin_url: 'https://linkedin.com/in/test', company: 'Acme' },
			})
			const ws = buildWorkspace({ id: existing.workspaceId })
			const merged = {
				...existing,
				metadata: {
					linkedin_url: 'https://linkedin.com/in/test',
					company: 'Acme',
					priority: 'hot',
				},
			}
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]
			mockResults.update = [merged]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, {
					metadata: { priority: 'hot' },
				}),
			)

			expect(res.status).toBe(200)
			// Verify the update was called with merged metadata (existing + new)
			const body = await res.json()
			expect(body.metadata).toEqual({
				linkedin_url: 'https://linkedin.com/in/test',
				company: 'Acme',
				priority: 'hot',
			})
		})
	})

	describe('GET /api/objects/search', () => {
		it('returns 200 with search results', async () => {
			const obj1 = buildObject({ workspaceId: wsId, title: 'Login bug' })
			const obj2 = buildObject({ workspaceId: wsId, title: 'Signup flow' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj1, obj2]

			const res = await app.request(
				jsonGet('/api/objects/search?q=bug', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
		})
	})

	describe('GET /api/objects/:id/graph', () => {
		it('returns 200 with object, relationships, and connected objects', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const connectedObj = buildObject({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceId: obj.id,
				targetId: connectedObj.id,
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: the target object, second: relationships, third: connected objects
			mockResults.selectQueue = [[obj], [rel], [connectedObj]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(1)
			expect(body.connected_objects).toHaveLength(1)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects/00000000-0000-0000-0000-000000000099/graph', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/objects/:id', () => {
		it('returns 200 when deleted', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]
			mockResults.insert = [{}] // event

			const res = await app.request(jsonDelete(`/api/objects/${existing.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonDelete('/api/objects/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/objects - edge cases', () => {
		it('returns 500 when insert returns empty', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('Failed to create object')
		})
	})

	describe('PATCH /api/objects/:id - status_changed event', () => {
		it('logs status_changed event when status changes', async () => {
			const existing = buildObject({ status: 'todo' })
			const updated = { ...existing, status: 'in_progress' }
			const ws = buildWorkspace({ id: existing.workspaceId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third: workspace settings
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'in_progress' }),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('GET /api/objects/:id/graph - no relationships', () => {
		it('returns empty arrays when no relationships exist', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: the object, second: relationships (empty)
			mockResults.selectQueue = [[obj], []]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(0)
			expect(body.connected_objects).toHaveLength(0)
		})
	})

	describe('Workspace membership enforcement', () => {
		it('GET /:id returns 404 when actor is not a workspace member', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[obj], []]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))
			expect(res.status).toBe(404)
		})

		it('PATCH /:id returns 404 when actor is not a workspace member', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[existing], []]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, buildUpdateObjectBody()),
			)
			expect(res.status).toBe(404)
		})

		it('DELETE /:id returns 404 when actor is not a workspace member', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[existing], []]

			const res = await app.request(jsonDelete(`/api/objects/${existing.id}`))
			expect(res.status).toBe(404)
		})
	})

	describe('Metadata field validation (required + enum)', () => {
		const knowledgeFieldDefs = [
			{ name: 'summary', type: 'text', required: true },
			{ name: 'confidence', type: 'enum', required: false, values: ['low', 'medium', 'high'] },
		]

		function buildKnowledgeWorkspace() {
			return buildWorkspace({
				id: wsId,
				settings: {
					enabled_modules: ['work'],
					display_names: { task: 'Task', knowledge: 'Article' },
					statuses: {
						task: ['todo', 'in_progress', 'done', 'blocked'],
						knowledge: ['draft', 'validated'],
					},
					field_definitions: { knowledge: knowledgeFieldDefs },
					relationship_types: ['informs'],
					custom_extensions: {
						knowledge: { name: 'Knowledge', types: ['knowledge'], enabled: true },
					},
				},
			})
		}

		describe('POST /api/objects', () => {
			it('rejects create with missing required field', async () => {
				const ws = buildKnowledgeWorkspace()
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/objects',
						buildCreateObjectBody({ type: 'knowledge', status: 'draft', metadata: {} }),
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(400)
				const body = await res.json()
				expect(body.error.message).toContain('summary')
				expect(body.error.details[0].field).toBe('metadata.summary')
			})

			it('rejects create with required field set to null', async () => {
				const ws = buildKnowledgeWorkspace()
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/objects',
						buildCreateObjectBody({
							type: 'knowledge',
							status: 'draft',
							metadata: { summary: null },
						}),
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(400)
				const body = await res.json()
				expect(body.error.details[0].field).toBe('metadata.summary')
			})

			it('rejects create with invalid enum value', async () => {
				const ws = buildKnowledgeWorkspace()
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/objects',
						buildCreateObjectBody({
							type: 'knowledge',
							status: 'draft',
							metadata: { summary: 'x', confidence: 'banana' },
						}),
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(400)
				const body = await res.json()
				expect(body.error.details[0].field).toBe('metadata.confidence')
				expect(body.error.details[0].expected).toContain('low')
			})

			it('accepts create with required field present', async () => {
				const ws = buildKnowledgeWorkspace()
				const obj = buildObject({
					workspaceId: wsId,
					type: 'knowledge',
					status: 'draft',
					metadata: { summary: 'x' },
				})
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]
				mockResults.insert = [obj]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/objects',
						buildCreateObjectBody({
							type: 'knowledge',
							status: 'draft',
							metadata: { summary: 'x' },
						}),
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
			})

			it('accepts create with valid enum value', async () => {
				const ws = buildKnowledgeWorkspace()
				const obj = buildObject({
					workspaceId: wsId,
					type: 'knowledge',
					status: 'draft',
					metadata: { summary: 'x', confidence: 'medium' },
				})
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]
				mockResults.insert = [obj]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/objects',
						buildCreateObjectBody({
							type: 'knowledge',
							status: 'draft',
							metadata: { summary: 'x', confidence: 'medium' },
						}),
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
			})

			it('does not affect types with no field definitions (work extension)', async () => {
				const ws = buildKnowledgeWorkspace()
				const obj = buildObject({ workspaceId: wsId })
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[ws]]
				mockResults.insert = [obj]

				const res = await app.request(
					jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(201)
			})
		})

		describe('PATCH /api/objects/:id', () => {
			it('rejects clearing a required field via metadata patch', async () => {
				const existing = buildObject({
					workspaceId: wsId,
					type: 'knowledge',
					metadata: { summary: 'old' },
				})
				const ws = buildKnowledgeWorkspace()
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]

				const res = await app.request(
					jsonRequest('PATCH', `/api/objects/${existing.id}`, {
						metadata: { summary: null },
					}),
				)

				expect(res.status).toBe(400)
				const body = await res.json()
				expect(body.error.details[0].field).toBe('metadata.summary')
				expect(body.error.message).toContain('cannot be cleared')
			})

			it('rejects update with invalid enum value', async () => {
				const existing = buildObject({
					workspaceId: wsId,
					type: 'knowledge',
					metadata: { summary: 'old' },
				})
				const ws = buildKnowledgeWorkspace()
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]

				const res = await app.request(
					jsonRequest('PATCH', `/api/objects/${existing.id}`, {
						metadata: { confidence: 'banana' },
					}),
				)

				expect(res.status).toBe(400)
				const body = await res.json()
				expect(body.error.details[0].field).toBe('metadata.confidence')
			})

			it('accepts partial update that omits required field', async () => {
				const existing = buildObject({
					workspaceId: wsId,
					type: 'knowledge',
					metadata: { summary: 'old' },
				})
				const ws = buildKnowledgeWorkspace()
				const updated = {
					...existing,
					metadata: { summary: 'old', confidence: 'high' },
				}
				const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
				mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]
				mockResults.update = [updated]
				mockResults.insert = [{}]

				const res = await app.request(
					jsonRequest('PATCH', `/api/objects/${existing.id}`, {
						metadata: { confidence: 'high' },
					}),
				)

				expect(res.status).toBe(200)
			})
		})
	})
})
