import { randomUUID } from 'node:crypto'
import {
	buildCreateObjectBody,
	buildEvent,
	buildFile,
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

		it('returns 200 (fallback sort) for invalid sort field with special chars', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=;DROP TABLE', { 'x-workspace-id': wsId }),
			)

			// Unknown/unsafe sort fields fall back to createdAt rather than returning 400,
			// so objects are always shown even when a custom field name is unsortable.
			expect(res.status).toBe(200)
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

		it('returns 200 (fallback sort) for unknown sort field', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects?sort=foobar', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
		})

		it('returns 200 (fallback sort) for metadata sort field with dots', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=metadata.a.b', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
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

		it('includes is_subscribed / unread_count / subscriber_count fields', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			// Fields are always present, even when storage is empty (defaults zeroed).
			expect(body).toHaveProperty('is_subscribed')
			expect(body).toHaveProperty('unread_count')
			expect(body).toHaveProperty('subscriber_count')
			expect(typeof body.unread_count).toBe('number')
			expect(typeof body.subscriber_count).toBe('number')
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})

		it('returns null activeSessionCurrentActivity when object has no active session', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.activeSessionCurrentActivity).toBeNull()
		})

		it('embeds activeSessionCurrentActivity when session is active', async () => {
			const sessionId = randomUUID()
			const obj = buildObject({ activeSessionId: sessionId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[obj], // object lookup
				[obj], // isWorkspaceMember
				[], // isSubscribed
				[], // getUnreadCount
				[], // getSubscriberCount
				[{ currentActivity: 'Searching codebase' }], // session currentActivity query
			]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.activeSessionCurrentActivity).toBe('Searching codebase')
		})
	})

	describe('PATCH /api/objects/:id', () => {
		it('returns 200 when object updated', async () => {
			const existing = buildObject()
			const updated = { ...existing, title: 'Updated title' }
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third:
			// the in-transaction FOR UPDATE re-read used to derive the event action
			// and the terminal-notification guard.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, buildUpdateObjectBody()),
			)

			expect(res.status).toBe(200)
		})

		it("emits an 'updated' event with data.changes for a single-field edit", async () => {
			const existing = buildObject({ title: 'Old title' })
			const updated = { ...existing, title: 'New title' }
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third:
			// the in-transaction FOR UPDATE re-read used to derive the event action
			// and the terminal-notification guard.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			await app.request(jsonRequest('PATCH', `/api/objects/${existing.id}`, { title: 'New title' }))

			const eventInsert = calls.inserts.find(
				(row): row is { action: string; entityId: string; data: unknown } =>
					typeof row === 'object' &&
					row !== null &&
					(row as { entityId?: unknown }).entityId === existing.id,
			)
			expect(eventInsert).toBeDefined()
			expect(eventInsert?.action).toBe('updated')
			expect(eventInsert?.data).toEqual({
				changes: [{ field: 'title', old: 'Old title', new: 'New title' }],
			})
			expect(eventInsert?.data).not.toHaveProperty('previous')
			expect(eventInsert?.data).not.toHaveProperty('updated')
		})

		it("emits a 'status_changed' event with data.changes = [{field: 'status', …}] on status-only edit", async () => {
			const existing = buildObject({ status: 'signal' })
			const updated = { ...existing, status: 'active' }
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			const ws = buildWorkspace({
				id: existing.workspaceId,
				settings: { statuses: { [existing.type]: ['signal', 'active'] } },
			})
			// First select: existing object, second: workspace membership, third:
			// workspace settings, fourth: the in-transaction FOR UPDATE re-read.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws], [existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			await app.request(jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'active' }))

			const eventInsert = calls.inserts.find(
				(row): row is { action: string; entityId: string; data: unknown } =>
					typeof row === 'object' &&
					row !== null &&
					(row as { entityId?: unknown }).entityId === existing.id,
			)
			expect(eventInsert?.action).toBe('status_changed')
			expect(eventInsert?.data).toEqual({
				changes: [{ field: 'status', old: 'signal', new: 'active' }],
			})
		})

		it('emits N-element data.changes for a multi-field edit', async () => {
			const existing = buildObject({ title: 'Old', status: 'signal' })
			const updated = { ...existing, title: 'New', status: 'active' }
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			const ws = buildWorkspace({
				id: existing.workspaceId,
				settings: { statuses: { [existing.type]: ['signal', 'active'] } },
			})
			// First select: existing object, second: workspace membership, third:
			// workspace settings, fourth: the in-transaction FOR UPDATE re-read.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws], [existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, {
					title: 'New',
					status: 'active',
				}),
			)

			const eventInsert = calls.inserts.find(
				(row): row is { action: string; data: { changes: unknown[] } } =>
					typeof row === 'object' &&
					row !== null &&
					(row as { entityId?: unknown }).entityId === existing.id,
			)
			expect(eventInsert?.action).toBe('status_changed')
			expect(eventInsert?.data.changes).toEqual(
				expect.arrayContaining([
					{ field: 'status', old: 'signal', new: 'active' },
					{ field: 'title', old: 'Old', new: 'New' },
				]),
			)
			expect(eventInsert?.data.changes).toHaveLength(2)
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
			const merged = {
				...existing,
				metadata: {
					linkedin_url: 'https://linkedin.com/in/test',
					company: 'Acme',
					priority: 'hot',
				},
			}
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third:
			// the in-transaction FOR UPDATE re-read.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [existing]]
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

		it('returns 400 when a metadata.<field> filter has an unsafe field name', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects/search?q=bug&metadata.bad-field=auto', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('bad-field')
			expect(body.error.details?.[0]?.field).toBe('metadata.bad-field')
		})

		it('accepts a valid metadata.<field> filter and returns results', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet(
					'/api/objects/search?q=onboarding&type=bet&metadata.promotion_mode=human_approved',
					{
						'x-workspace-id': wsId,
					},
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
		})

		it('does not require a type filter to apply a metadata.<field> filter', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet('/api/objects/search?q=bug&metadata.segment=enterprise', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('GET /api/objects/board', () => {
		it('returns column totals and paged objects', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[ws],
				[
					{ value: 'todo', total: 3 },
					{ value: 'in_progress', total: 1 },
				],
				[obj1, obj2],
				[],
				[],
				[],
			]

			const res = await app.request(
				jsonGet('/api/objects/board?type=task&limit=2', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			const todo = body.columns.find((column: { value: string }) => column.value === 'todo')
			expect(todo.total).toBe(3)
			expect(todo.objects).toHaveLength(2)
		})
	})

	describe('GET /api/objects/:id/graph', () => {
		it('returns 200 with object, relationships, connected objects, and events', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const connectedObj = buildObject({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceId: obj.id,
				targetId: connectedObj.id,
			})
			const comment = buildEvent({
				workspaceId: wsId,
				entityType: 'object',
				entityId: obj.id,
				action: 'commented',
				data: { content: 'looks good' },
			})
			const lifecycleEvent = buildEvent({
				workspaceId: wsId,
				entityType: obj.type,
				entityId: obj.id,
				action: 'created',
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) target object, 2) relationships, 3) files-membership lookup
			// (endpoints checked against `files` table so the read layer resolves by
			// id — returns [] here because `connectedObj` is not a file),
			// 4) connected objects, 5) events.
			mockResults.selectQueue = [[obj], [rel], [], [connectedObj], [comment, lifecycleEvent]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(1)
			expect(body.connected_objects).toHaveLength(1)
			expect(body.events).toHaveLength(2)
			expect(body.events[0].action).toBe('commented')
			// Server-side formatted description matches what the UI renders
			expect(body.events[1].description).toBe('proposed bet')
		})

		it('resolves actor names for driver-change events in description', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const alice = { id: '00000000-0000-0000-0000-0000000000a1', name: 'Alice' }
			const bob = { id: '00000000-0000-0000-0000-0000000000b2', name: 'Bob' }
			const driverChange = buildEvent({
				workspaceId: wsId,
				entityType: 'bet',
				entityId: obj.id,
				action: 'updated',
				data: {
					previous: { driver: alice.id },
					updated: { driver: bob.id },
				},
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1: object, 2: relationships (empty → skips connected_objects fetch), 3: events, 4: actors
			mockResults.selectQueue = [[obj], [], [driverChange], [alice, bob]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.events).toHaveLength(1)
			expect(body.events[0].description).toBe('changed driver from Alice to Bob')
		})

		it('resolves actor names for driver-change events emitted in the new {changes} shape', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const alice = { id: '00000000-0000-0000-0000-0000000000a1', name: 'Alice' }
			const bob = { id: '00000000-0000-0000-0000-0000000000b2', name: 'Bob' }
			const driverChange = buildEvent({
				workspaceId: wsId,
				entityType: 'bet',
				entityId: obj.id,
				action: 'updated',
				data: {
					changes: [{ field: 'driver', old: alice.id, new: bob.id }],
				},
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[obj], [], [driverChange], [alice, bob]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.events[0].description).toBe('changed driver from Alice to Bob')
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

		it('inlines attached file metadata (from relationships) in the files field', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const file = buildFile({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceType: 'bet',
				sourceId: obj.id,
				targetType: 'file',
				targetId: file.id,
				type: 'attached',
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Queue order matches handler call order: 1) object, 2) relationships,
			// 3) files-membership lookup (endpoint resolves to the `files` table so
			// it is bucketed as a file — skips connected_objects), 4) events,
			// 5-7) the three subscription queries fired in parallel (isSubscribed,
			// getUnreadCount, getSubscriberCount), 8) files summary.
			mockResults.selectQueue = [[obj], [rel], [{ id: file.id }], [], [], [], [], [file]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.files).toHaveLength(1)
			expect(body.files[0].id).toBe(file.id)
			expect(body.files[0].name).toBe(file.name)
			expect(body.files[0].mimeType).toBe('text/markdown')
			expect(body.files[0].url).toBe(`http://localhost:5173/${wsId}/files/${file.id}`)
		})

		it('inlines comment-attachment file metadata in the files field', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const file = buildFile({ workspaceId: wsId })
			const comment = buildEvent({
				workspaceId: wsId,
				entityType: 'object',
				entityId: obj.id,
				action: 'commented',
				data: { content: 'see file', attachmentFileIds: [file.id] },
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) object, 2) relationships (empty → skips connected_objects), 3) events,
			// 4-6) subscription queries, 7) files.
			mockResults.selectQueue = [[obj], [], [comment], [], [], [], [file]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.files).toHaveLength(1)
			expect(body.files[0].id).toBe(file.id)
		})

		it('returns empty files array when nothing is attached or referenced', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[obj], [], []]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.files).toEqual([])
		})

		it('resolves an edge whose sourceType label does not match the endpoint kind', async () => {
			// Regression for the bet: prior to id-based endpoint resolution, an
			// `informs` edge written with a specialised `sourceType` (`'insight'`)
			// still surfaced as expected because the label wasn't `'file'` — but
			// symmetric cases where a file endpoint was mislabeled would drop.
			// This test locks in that the read path never depends on the label:
			// the endpoint is resolved via the `files` table, and anything that
			// isn't a file is treated as an object endpoint.
			const bet = buildObject({ workspaceId: wsId, type: 'bet' })
			const insight = buildObject({ workspaceId: wsId, type: 'insight' })
			const rel = buildRelationship({
				sourceType: 'insight', // non-canonical — T1 convention would be 'object'
				sourceId: insight.id,
				targetType: 'bet', // non-canonical — T1 convention would be 'object'
				targetId: bet.id,
				type: 'informs',
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) bet, 2) relationships, 3) files-membership lookup (endpoint is
			// not a file → []), 4) connected objects (insight), 5) events.
			mockResults.selectQueue = [[bet], [rel], [], [insight], []]

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.relationships).toHaveLength(1)
			expect(body.relationships[0].id).toBe(rel.id)
			expect(body.connected_objects).toHaveLength(1)
			expect(body.connected_objects[0].id).toBe(insight.id)
		})

		it('resolves a file endpoint even when the edge label is a legacy object type', async () => {
			// The mirror case: an `attached` edge whose file endpoint is stamped
			// with a legacy label (e.g. `'bet'`) rather than the canonical
			// `'file'`. The endpoint id lives in the `files` table, so the read
			// layer buckets it as a file — the attachment surfaces in
			// `files`, not as a broken row in `connected_objects`.
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const file = buildFile({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceType: 'bet',
				sourceId: obj.id,
				targetType: 'bet', // legacy mislabel — endpoint is a file
				targetId: file.id,
				type: 'attached',
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) object, 2) relationships, 3) files-membership lookup returns the
			// file (endpoint id resolves to `files.id`), so no connected_objects
			// fetch, 4) events, 5-7) subscription queries, 8) files summary.
			mockResults.selectQueue = [[obj], [rel], [{ id: file.id }], [], [], [], [], [file]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.connected_objects).toEqual([])
			expect(body.files).toHaveLength(1)
			expect(body.files[0].id).toBe(file.id)
		})
	})

	describe('GET /api/objects/:id/references', () => {
		it('returns the unique-context count with the 7-day window', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'knowledge' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// One SELECT: the COUNT DISTINCT aggregate. The mock DB harness returns
			// whatever we queue for the aggregate row.
			mockResults.selectQueue = [[{ unique_contexts: 3 }]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/references`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ window_days: 7, unique_contexts: 3 })
		})

		it('returns 0 when no reference events exist', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'knowledge' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Empty aggregate row — the coalesce in the handler falls back to 0.
			mockResults.selectQueue = [[{ unique_contexts: null }]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/references`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.unique_contexts).toBe(0)
			expect(body.window_days).toBe(7)
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
			// First select: existing object, second: workspace membership, third:
			// workspace settings, fourth: the in-transaction FOR UPDATE re-read.
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws], [existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'in_progress' }),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('GET /api/objects/:id/graph - no relationships', () => {
		it('returns empty arrays when no relationships or events exist', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: the object, second: relationships (empty), third: events (empty)
			mockResults.selectQueue = [[obj], [], []]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(0)
			expect(body.connected_objects).toHaveLength(0)
			expect(body.events).toHaveLength(0)
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

	describe('POST /api/objects/:id/verification', () => {
		// A Knowledge Author write — knowledge object with `provenance` containing "writer".
		function buildKnowledgeWrite(overrides?: Record<string, unknown>) {
			return buildObject({
				type: 'knowledge',
				metadata: { provenance: 'writer, claude-sonnet' },
				...overrides,
			})
		}

		it('stamps verification and emits a verified event on the object timeline', async () => {
			const existing = buildKnowledgeWrite()
			const updated = { ...existing }
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[existing], // initial fetch
				[buildWorkspaceMember()], // isWorkspaceMember
				[{ role: 'admin', type: 'human' }], // isWorkspaceHumanAdminOrOwner
				[existing], // in-tx FOR UPDATE re-read
			]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: true }),
			)

			expect(res.status).toBe(200)
			const eventInsert = calls.inserts.find(
				(row): row is { action: string; entityId: string; data: unknown } =>
					typeof row === 'object' &&
					row !== null &&
					(row as { entityId?: unknown }).entityId === existing.id,
			)
			expect(eventInsert?.action).toBe('verified')
			expect((eventInsert?.data as { verified?: boolean }).verified).toBe(true)
			const patchSet = calls.updates[0] as { metadata: Record<string, unknown> }
			expect(patchSet.metadata.verified_by).toBeTruthy()
			expect(typeof patchSet.metadata.verified_at).toBe('string')
		})

		it('unstamps verification and clears the metadata fields', async () => {
			const existing = buildKnowledgeWrite({
				metadata: {
					provenance: 'writer',
					verified_by: 'actor-x',
					verified_at: '2026-06-01T00:00:00.000Z',
				},
			})
			const updated = { ...existing }
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[existing],
				[buildWorkspaceMember()],
				[{ role: 'owner', type: 'human' }],
				[existing],
			]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: false }),
			)

			expect(res.status).toBe(200)
			const eventInsert = calls.inserts.find(
				(row): row is { action: string; entityId: string; data: unknown } =>
					typeof row === 'object' &&
					row !== null &&
					(row as { entityId?: unknown }).entityId === existing.id,
			)
			expect(eventInsert?.action).toBe('unverified')
			const patchSet = calls.updates[0] as { metadata: Record<string, unknown> }
			expect(patchSet.metadata.verified_by).toBeUndefined()
			expect(patchSet.metadata.verified_at).toBeUndefined()
			// Provenance and other unrelated metadata are preserved.
			expect(patchSet.metadata.provenance).toBe('writer')
		})

		it('returns 409 when the object is not a knowledge type', async () => {
			const existing = buildObject({ type: 'task' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: true }),
			)

			expect(res.status).toBe(409)
		})

		it('returns 409 when the knowledge object has no writer provenance', async () => {
			const existing = buildObject({
				type: 'knowledge',
				metadata: { provenance: 'human-review' },
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: true }),
			)

			expect(res.status).toBe(409)
		})

		it('returns 403 when caller is a member but not admin/owner', async () => {
			const existing = buildKnowledgeWrite()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[existing],
				[buildWorkspaceMember({ role: 'member' })],
				[], // isWorkspaceHumanAdminOrOwner: no matching row
			]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: true }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 403 when caller is an agent (even with admin role)', async () => {
			const existing = buildKnowledgeWrite()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [
				[existing],
				[buildWorkspaceMember({ role: 'admin' })],
				// The join filters agents out server-side; helper returns [] here.
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${existing.id}/verification`, { verified: true }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when the object does not exist', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/objects/00000000-0000-0000-0000-000000000099/verification', {
					verified: true,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/objects/migrate-type', () => {
		it('returns 200 and migrates rows to the new type', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task', status: 'done' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) workspace lookup, 2) rows of fromType
			mockResults.selectQueue = [[ws], [obj1, obj2]]
			// 2 update calls + 2 event inserts inside the transaction
			mockResults.update = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({
				mode: 'migrate',
				fromType: 'task',
				toType: 'bet',
				count: 2,
			})
		})

		it('returns 200 and 0 count when fromType has no rows', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.count).toBe(0)
		})

		it('returns 400 for invalid toType', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'nonexistent', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when mode=migrate omits toType', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when fromType equals toType', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'task', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 200 and deletes rows in delete mode', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'task' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) workspace lookup, 2) rows to delete (id list)
			mockResults.selectQueue = [[ws], [{ id: obj1.id }]]
			mockResults.delete = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', mode: 'delete' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({ mode: 'delete', fromType: 'task', count: 1 })
		})

		it('applies statusMap and falls back when target lacks the source status', async () => {
			const ws = buildWorkspace({ id: wsId })
			// 'task' statuses → ['todo', 'in_progress', 'done', 'blocked']
			// 'bet'  statuses → ['signal', 'proposed', 'active', ...] — no overlap
			const obj1 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task', status: 'done' })
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws], [obj1, obj2]]
			mockResults.update = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{
						fromType: 'task',
						toType: 'bet',
						mode: 'migrate',
						// 'todo' is mapped explicitly; 'done' has no entry → uses fallback
						statusMap: { todo: 'active' },
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			// First update: 'todo' → 'active' via statusMap
			expect(calls.updates[0]).toMatchObject({ type: 'bet', status: 'active' })
			// Second update: 'done' isn't a valid bet status and isn't in statusMap → first bet status
			expect(calls.updates[1]).toMatchObject({ type: 'bet', status: 'signal' })
		})

		it('returns 400 when target type has no statuses configured', async () => {
			const ws = buildWorkspace({
				id: wsId,
				settings: {
					enabled_modules: ['work'],
					display_names: { bet: 'Bet', task: 'Task' },
					statuses: {
						task: ['todo', 'done'],
						bet: [],
					},
				},
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 404 when workspace not found', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})
	})
})
