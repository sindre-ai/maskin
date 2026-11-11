import { randomUUID } from 'node:crypto'
import {
	TARGETS_DEFAULT_SETTINGS,
	TARGET_OF_RELATIONSHIP_TYPE,
	TARGET_STATUSES,
	TARGET_TYPE,
} from '@maskin/ext-targets/shared'
import { getAllValidTypes, getModuleDefaultSettings } from '@maskin/module-sdk'
import { vi } from 'vitest'
import {
	buildCreateObjectBody,
	buildObject,
	buildRelationship,
	buildWorkspace,
	buildWorkspaceMember,
} from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: graphRoutes } = await import('../../routes/graph')
const { default: objectsRoutes } = await import('../../routes/objects')
const { default: relationshipsRoutes } = await import('../../routes/relationships')

const wsId = '00000000-0000-0000-0000-000000000001'

// A workspace that enabled the targets extension: what create_extension with
// id "targets" writes into its settings (the module's default settings).
function workspaceWithTargets() {
	const base = buildWorkspace({ id: wsId })
	return {
		...base,
		settings: {
			...base.settings,
			enabled_modules: [...base.settings.enabled_modules, 'targets'],
			display_names: { ...base.settings.display_names, ...TARGETS_DEFAULT_SETTINGS.display_names },
			statuses: { ...base.settings.statuses, ...TARGETS_DEFAULT_SETTINGS.statuses },
			field_definitions: {
				...base.settings.field_definitions,
				...TARGETS_DEFAULT_SETTINGS.field_definitions,
			},
			relationship_types: [
				...base.settings.relationship_types,
				...(TARGETS_DEFAULT_SETTINGS.relationship_types ?? []),
			],
		},
	}
}

const targetMetadata = {
	deadline: '2026-12-31',
	source: 'metric:billing.paying_customers',
	actual: 3,
	target: 10,
}

// POST /api/relationships first asks which endpoint ids live in the caller's
// workspace: one select on objects, one on files (queued in that order).
function endpointsInWorkspace(...ids: string[]) {
	return [ids.map((id) => ({ id })), []]
}

describe('Targets extension', () => {
	describe('module', () => {
		it('adds the target type with the statuses and fields of a flow target row plus a deadline', () => {
			const defaults = getModuleDefaultSettings('targets')

			expect(defaults?.statuses).toEqual({ target: ['open', 'hit', 'missed', 'dropped'] })
			expect(defaults?.field_definitions?.target?.map((f) => [f.name, f.type])).toEqual([
				['deadline', 'date'],
				['source', 'text'],
				['actual', 'number'],
				['target', 'number'],
			])
		})

		it('lists the flow link type so it is picked from the workspace link types', () => {
			expect(getModuleDefaultSettings('targets')?.relationship_types).toEqual([
				'breaks_into',
				'target_of',
			])
		})

		it('makes target a valid type only where the module is enabled', () => {
			expect(getAllValidTypes(['work', 'targets'])).toContain('target')
			expect(getAllValidTypes(['work'])).not.toContain('target')
		})
	})

	describe('POST /api/objects', () => {
		it('creates a target with an owner, a deadline, a source, an actual and a target number', async () => {
			const owner = randomUUID()
			const obj = buildObject({
				workspaceId: wsId,
				type: TARGET_TYPE,
				status: 'open',
				title: '10 paying customers',
				driver: owner,
				metadata: targetMetadata,
			})
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[workspaceWithTargets()]]
			mockResults.insert = [obj]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({
						type: TARGET_TYPE,
						status: 'open',
						title: '10 paying customers',
						driver: owner,
						metadata: targetMetadata,
					}),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.type).toBe('target')
			expect(body.driver).toBe(owner)
			expect(body.metadata).toEqual(targetMetadata)
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({
					type: 'target',
					status: 'open',
					driver: owner,
					metadata: targetMetadata,
				}),
			)
		})

		it.each(TARGET_STATUSES)('accepts the status %s', async (status) => {
			const obj = buildObject({ workspaceId: wsId, type: TARGET_TYPE, status })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[workspaceWithTargets()]]
			mockResults.insert = [obj]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ type: TARGET_TYPE, status }), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
		})

		it('rejects a status that is not one of the target statuses', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[workspaceWithTargets()]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: TARGET_TYPE, status: 'todo' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('rejects a target in a workspace that has not enabled the extension', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[buildWorkspace({ id: wsId })]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: TARGET_TYPE, status: 'open' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('PATCH /api/objects/:id', () => {
		it('updates the actual number and moves a target to hit', async () => {
			const existing = buildObject({
				workspaceId: wsId,
				type: TARGET_TYPE,
				status: 'open',
				metadata: targetMetadata,
			})
			const updated = {
				...existing,
				status: 'hit',
				metadata: { ...targetMetadata, actual: 10 },
			}
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			// existing object, workspace membership, workspace settings (status
			// check), then the in-transaction re-read.
			mockResults.selectQueue = [
				[existing],
				[buildWorkspaceMember()],
				[workspaceWithTargets()],
				[existing],
			]
			mockResults.update = [updated]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, {
					status: 'hit',
					metadata: { ...targetMetadata, actual: 10 },
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.status).toBe('hit')
			expect(body.metadata.actual).toBe(10)
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({ action: 'status_changed', entityId: existing.id }),
			)
		})

		it('rejects a status that is not one of the target statuses', async () => {
			const existing = buildObject({ workspaceId: wsId, type: TARGET_TYPE, status: 'open' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [workspaceWithTargets()]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'done' }),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('PATCH /api/objects/:id by an agent', () => {
		// existing object, workspace membership, then the in-transaction re-read
		// (no status in the body, so no workspace settings read).
		function patchAs(actorType: string, existing: ReturnType<typeof buildObject>, body: object) {
			const { app, mockResults, calls } = createTestApp(
				objectsRoutes,
				'/api/objects',
				'test-actor-id',
				actorType,
			)
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [existing]]
			mockResults.update = [{ ...existing, ...body }]
			mockResults.insert = [{}]
			return {
				calls,
				res: app.request(jsonRequest('PATCH', `/api/objects/${existing.id}`, body)),
			}
		}

		const target = () =>
			buildObject({
				workspaceId: wsId,
				type: TARGET_TYPE,
				status: 'open',
				title: '10 paying customers',
				metadata: targetMetadata,
			})

		it.each([
			['actual', { actual: 10 }],
			['target', { target: 20 }],
			['deadline', { deadline: '2027-01-31' }],
			['source', { source: 'metric:other' }],
		])(
			'refuses an agent changing the %s of a target, and says to use a decision card',
			async (field, change) => {
				const existing = target()
				const { res, calls } = patchAs('agent', existing, {
					metadata: { ...targetMetadata, ...change },
				})

				const response = await res
				expect(response.status).toBe(403)
				const body = await response.json()
				expect(body.error.message).toContain(field)
				expect(body.error.message).toContain('decision card')
				expect(calls.updates).toHaveLength(0)
				expect(calls.inserts).toHaveLength(0)
			},
		)

		it('refuses an agent changing the label of a target', async () => {
			const { res } = patchAs('agent', target(), { title: '20 paying customers' })

			expect((await res).status).toBe(403)
		})

		it('lets an agent write a target field back unchanged', async () => {
			const { res } = patchAs('agent', target(), { metadata: { actual: 3 } })

			expect((await res).status).toBe(200)
		})

		it('lets a person change the fields of a target', async () => {
			const { res } = patchAs('human', target(), { metadata: { ...targetMetadata, actual: 10 } })

			expect((await res).status).toBe(200)
		})

		it('refuses an agent changing the targets or the close condition of a flow', async () => {
			for (const metadata of [
				{ targets: [{ label: 'Signups', actual: 1, target: 5 }] },
				{ close_condition: 'Never closes' },
			]) {
				const flow = buildObject({
					workspaceId: wsId,
					type: 'loop',
					status: 'live',
					metadata: { targets: [], close_condition: 'Shipped' },
				})
				const { res } = patchAs('agent', flow, { metadata })

				const response = await res
				expect(response.status).toBe(403)
				expect((await response.json()).error.message).toContain('decision card')
			}
		})

		it('lets an agent change other flow fields and pause a flow', async () => {
			const flow = buildObject({
				workspaceId: wsId,
				type: 'loop',
				status: 'live',
				metadata: { targets: [], close_condition: 'Shipped', note: 'a' },
			})
			const { res } = patchAs('agent', flow, { metadata: { note: 'b', targets: [] } })

			expect((await res).status).toBe(200)
		})

		it('lets a person change the targets of a flow', async () => {
			const flow = buildObject({
				workspaceId: wsId,
				type: 'loop',
				status: 'live',
				metadata: { targets: [] },
			})
			const { res } = patchAs('human', flow, {
				metadata: { targets: [{ label: 'Signups', actual: 1, target: 5 }] },
			})

			expect((await res).status).toBe(200)
		})
	})

	describe('POST /api/graph (the create_objects tool)', () => {
		it('creates a company target and a flow target linked with breaks_into', async () => {
			const company = buildObject({ workspaceId: wsId, type: TARGET_TYPE, status: 'open' })
			const flowTarget = buildObject({ workspaceId: wsId, type: TARGET_TYPE, status: 'open' })
			const rel = buildRelationship({
				sourceId: company.id,
				targetId: flowTarget.id,
				type: 'breaks_into',
			})
			const { app, mockResults, calls } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[workspaceWithTargets()]]
			// node1, its event, node2, its event, edge, its event, then one
			// auto-subscribe per node
			mockResults.insertQueue = [[company], [{}], [flowTarget], [{}], [rel], [{}], [], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [
							{
								$id: 'company',
								type: TARGET_TYPE,
								title: '10 paying customers',
								status: 'open',
								metadata: targetMetadata,
							},
							{
								$id: 'flow',
								type: TARGET_TYPE,
								title: '4 paying customers from webinars',
								status: 'open',
								metadata: { ...targetMetadata, actual: 1, target: 4 },
							},
						],
						edges: [{ source: 'company', target: 'flow', type: 'breaks_into' }],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.nodes).toHaveLength(2)
			expect(body.edges).toHaveLength(1)
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({ type: 'target', metadata: targetMetadata }),
			)
		})

		it('rejects a target node in a workspace that has not enabled the extension', async () => {
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[buildWorkspace({ id: wsId })]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'a', type: TARGET_TYPE, title: 'A target', status: 'open' }],
						edges: [],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('POST /api/relationships', () => {
		it('links a company target down to a flow target with breaks_into', async () => {
			const companyTarget = randomUUID()
			const flowTarget = randomUUID()
			const rel = buildRelationship({
				sourceId: companyTarget,
				targetId: flowTarget,
				type: 'breaks_into',
			})
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.selectQueue = [...endpointsInWorkspace(companyTarget, flowTarget)]
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: companyTarget,
						target_type: 'object',
						target_id: flowTarget,
						type: 'breaks_into',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect((await res.json()).type).toBe('breaks_into')
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({
					sourceId: companyTarget,
					targetId: flowTarget,
					type: 'breaks_into',
				}),
			)
		})

		it('links a flow target to its flow with target_of, not the in_loop membership edge', async () => {
			const flowTarget = randomUUID()
			const flow = randomUUID()
			const rel = buildRelationship({
				sourceId: flowTarget,
				targetId: flow,
				type: TARGET_OF_RELATIONSHIP_TYPE,
			})
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.selectQueue = [...endpointsInWorkspace(flowTarget, flow)]
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: flowTarget,
						target_type: 'object',
						target_id: flow,
						type: 'target_of',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect((await res.json()).type).toBe('target_of')
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({ sourceId: flowTarget, targetId: flow, type: 'target_of' }),
			)
			expect(calls.inserts).not.toContainEqual(expect.objectContaining({ type: 'in_loop' }))
		})
	})
})
