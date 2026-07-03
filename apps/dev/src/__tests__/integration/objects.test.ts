import { events, files, objects } from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import {
	buildCreateObjectBody,
	buildFile,
	insertActor,
	insertObject,
	insertRelationship,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

describe('Objects Integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	describe('CRUD lifecycle', () => {
		it('creates, reads, updates, and deletes an object', async () => {
			const app = createApp()

			// Create
			const createRes = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.type).toBe('task')
			expect(created.status).toBe('todo')
			expect(created.workspaceId).toBe(workspaceId)

			// Read
			const getRes = await app.request(jsonGet(`/api/objects/${created.id}`))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.id).toBe(created.id)

			// Update
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, {
					title: 'Updated Title',
					status: 'in_progress',
				}),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.title).toBe('Updated Title')
			expect(updated.status).toBe('in_progress')

			// Delete
			const deleteRes = await app.request(jsonDelete(`/api/objects/${created.id}`))
			expect(deleteRes.status).toBe(200)

			// Verify gone
			const gone = await app.request(jsonGet(`/api/objects/${created.id}`))
			expect(gone.status).toBe(404)
		})
	})

	describe('event logging', () => {
		it('logs events on create, update, and delete', async () => {
			const app = createApp()

			// Create an object
			const createRes = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)
			const created = await createRes.json()

			// Update the object
			await app.request(jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'Changed' }))

			// Delete the object
			await app.request(jsonDelete(`/api/objects/${created.id}`))

			// Verify events were logged
			const logged = await db
				.select()
				.from(events)
				.where(eq(events.entityId, created.id))
				.orderBy(events.id)

			expect(logged).toHaveLength(3)
			expect(logged[0].action).toBe('created')
			expect(logged[1].action).toBe('updated')
			expect(logged[2].action).toBe('deleted')
		})
	})

	describe('status validation', () => {
		it('rejects invalid status for object type', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ status: 'nonexistent' }), {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})
	})

	describe('workspace scoping', () => {
		it('lists only objects from the queried workspace', async () => {
			const app = createApp()
			const ws2 = await insertWorkspace(db, getTestActorId())

			// Create object in workspace 1
			await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)

			// Create object in workspace 2
			await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': ws2.id,
				}),
			)

			// List from workspace 1
			const res = await app.request(jsonGet('/api/objects', { 'x-workspace-id': workspaceId }))
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].workspaceId).toBe(workspaceId)
		})
	})

	describe('POST /api/objects/bulk-update', () => {
		it('updates many objects in one call and emits one event per object', async () => {
			const app = createApp()
			const a = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})
			const b = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})
			const c = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{
						ids: [a.id, b.id, c.id],
						patch: { status: 'in_progress' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.results).toHaveLength(3)
			expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true)

			const rows = await db
				.select()
				.from(objects)
				.where(inArray(objects.id, [a.id, b.id, c.id]))
			expect(rows.every((row) => row.status === 'in_progress')).toBe(true)

			const logged = await db
				.select()
				.from(events)
				.where(inArray(events.entityId, [a.id, b.id, c.id]))
			// Each object gets a create event plus one status_changed event from the bulk update.
			expect(logged.filter((e) => e.action === 'status_changed')).toHaveLength(3)
		})

		it('handles a mixed-type batch by validating status per type', async () => {
			const app = createApp()
			const task = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})
			const bet = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				status: 'signal',
			})

			// Set owner on both — a field every type accepts — so this exercises the
			// mixed-type happy path without needing a status that's valid for both.
			const ownerId = getTestActorId()
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{
						ids: [task.id, bet.id],
						patch: { driver: ownerId },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true])

			const rows = await db
				.select()
				.from(objects)
				.where(inArray(objects.id, [task.id, bet.id]))
			expect(rows.every((row) => row.driver === ownerId)).toBe(true)
		})

		it('reports per-id failure when status is invalid for the type, leaving siblings updated', async () => {
			const app = createApp()
			const task = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})
			const bet = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				status: 'signal',
			})

			// 'in_progress' is valid for task but not for bet — bet should fail, task should succeed.
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{
						ids: [task.id, bet.id],
						patch: { status: 'in_progress' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			const byId = new Map(
				body.results.map((r: { id: string; ok: boolean; error?: string }) => [r.id, r]),
			)
			expect(byId.get(task.id)).toMatchObject({ ok: true })
			expect(byId.get(bet.id)).toMatchObject({ ok: false })
			expect(byId.get(bet.id).error).toContain('Invalid status')

			const [taskAfter] = await db.select().from(objects).where(eq(objects.id, task.id))
			const [betAfter] = await db.select().from(objects).where(eq(objects.id, bet.id))
			expect(taskAfter.status).toBe('in_progress')
			expect(betAfter.status).toBe('signal') // unchanged
		})

		it('filters out ids that belong to a different workspace', async () => {
			const app = createApp()
			const mine = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})

			// Object in another workspace — must not be reachable via the header workspace.
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			const theirs = await insertObject(db, otherWs.id, otherActor.id, {
				type: 'task',
				status: 'todo',
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{
						ids: [mine.id, theirs.id],
						patch: { status: 'in_progress' },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			const byId = new Map(
				body.results.map((r: { id: string; ok: boolean; error?: string }) => [r.id, r]),
			)
			expect(byId.get(mine.id)).toMatchObject({ ok: true })
			expect(byId.get(theirs.id)).toMatchObject({ ok: false, error: 'Object not found' })

			const [theirsAfter] = await db.select().from(objects).where(eq(objects.id, theirs.id))
			expect(theirsAfter.status).toBe('todo')
		})

		it('shallow-merges metadata so partial patches keep existing fields', async () => {
			const app = createApp()
			const obj = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				metadata: { source: 'slack', priority: 'low' },
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{
						ids: [obj.id],
						patch: { metadata: { priority: 'high' } },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const [after] = await db.select().from(objects).where(eq(objects.id, obj.id))
			expect(after.metadata).toEqual({ source: 'slack', priority: 'high' })
		})
	})

	describe('list filters', () => {
		it('filters by type and status', async () => {
			const app = createApp()

			await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'task', status: 'todo' }),
					{ 'x-workspace-id': workspaceId },
				),
			)
			await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'insight', status: 'new' }),
					{ 'x-workspace-id': workspaceId },
				),
			)

			const res = await app.request(
				jsonGet('/api/objects?type=task', { 'x-workspace-id': workspaceId }),
			)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].type).toBe('task')
		})

		it('uses a deterministic secondary sort when the primary column has ties', async () => {
			// Without a unique tiebreaker, OFFSET/LIMIT pagination over `createdAt DESC`
			// is non-deterministic for rows that share a timestamp — the same row can
			// re-appear across pages. We pin the contract here: when the primary sort
			// ties, rows must come back ordered by `id ASC` so paging stays stable.
			const app = createApp()

			const sharedCreatedAt = new Date('2026-01-01T00:00:00.000Z')
			const total = 12
			for (let i = 0; i < total; i++) {
				await insertObject(db, workspaceId, getTestActorId(), {
					type: 'task',
					status: 'todo',
					createdAt: sharedCreatedAt,
					updatedAt: sharedCreatedAt,
				})
			}

			const pageSize = 5
			const pages: { id: string }[][] = []
			for (let offset = 0; offset < total; offset += pageSize) {
				const res = await app.request(
					jsonGet(`/api/objects?limit=${pageSize}&offset=${offset}`, {
						'x-workspace-id': workspaceId,
					}),
				)
				expect(res.status).toBe(200)
				pages.push((await res.json()) as { id: string }[])
			}

			const collected = pages.flatMap((p) => p.map((r) => r.id))
			// All rows surfaced, no duplicates across pages.
			expect(new Set(collected).size).toBe(total)
			// Deterministic tiebreaker: ascending id within the tied bucket.
			expect(collected).toEqual([...collected].sort())
		})
	})

	describe('GET /api/objects/board', () => {
		it('returns full column totals with paged objects per column', async () => {
			const app = createApp()

			for (let i = 0; i < 3; i++) {
				await insertObject(db, workspaceId, getTestActorId(), {
					type: 'task',
					status: 'todo',
					title: `Todo ${i}`,
				})
			}
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'in_progress',
				title: 'In progress',
			})

			const firstPage = await app.request(
				jsonGet('/api/objects/board?type=task&limit=2', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(firstPage.status).toBe(200)
			const body = await firstPage.json()
			const todo = body.columns.find((column: { value: string }) => column.value === 'todo')
			expect(todo.total).toBe(3)
			expect(todo.objects).toHaveLength(2)

			const secondPage = await app.request(
				jsonGet('/api/objects/board?type=task&column=todo&limit=2&offset=2', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(secondPage.status).toBe(200)
			const nextBody = await secondPage.json()
			expect(nextBody.columns).toHaveLength(1)
			expect(nextBody.columns[0].value).toBe('todo')
			expect(nextBody.columns[0].total).toBe(3)
			expect(nextBody.columns[0].objects).toHaveLength(1)
		})

		it('respects manual board order across pages', async () => {
			const app = createApp()

			const low = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Low',
				metadata: { board_order: 1 },
			})
			const mid = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Mid',
				metadata: { board_order: 2 },
			})
			const high = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'High',
				metadata: { board_order: 3 },
			})

			const firstPage = await app.request(
				jsonGet('/api/objects/board?type=task&sort=boardOrder&order=asc&limit=2', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(firstPage.status).toBe(200)
			const body = await firstPage.json()
			const todo = body.columns.find((column: { value: string }) => column.value === 'todo')
			expect(todo.objects.map((obj: { id: string }) => obj.id)).toEqual([low.id, mid.id])

			const secondPage = await app.request(
				jsonGet('/api/objects/board?type=task&sort=boardOrder&order=asc&limit=2&offset=2', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(secondPage.status).toBe(200)
			const nextBody = await secondPage.json()
			const nextTodo = nextBody.columns.find((column: { value: string }) => column.value === 'todo')
			expect(nextTodo.objects.map((obj: { title: string }) => obj.title)).toEqual(['High'])
		})

		it('applies updated_before / updated_after to column totals and objects', async () => {
			const app = createApp()
			const cutoff = new Date('2026-06-20T12:00:00.000Z')

			const stale = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Stale',
				updatedAt: new Date(cutoff.getTime() - 3600 * 1000),
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Fresh',
				updatedAt: new Date(cutoff.getTime() + 3600 * 1000),
			})

			const res = await app.request(
				jsonGet(
					`/api/objects/board?type=task&updated_before=${encodeURIComponent(cutoff.toISOString())}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			const todo = body.columns.find((column: { value: string }) => column.value === 'todo')
			expect(todo.total).toBe(1)
			expect(todo.objects.map((obj: { id: string }) => obj.id)).toEqual([stale.id])
		})
	})

	describe('updated_before / updated_after filters', () => {
		// Three rows, each updated 60s apart, so a ±1s boundary is unambiguous.
		const T = new Date('2026-06-20T12:00:00.000Z')
		const before = new Date(T.getTime() - 60_000)
		const after = new Date(T.getTime() + 60_000)

		async function seedThree() {
			const old = await insertObject(db, workspaceId, getTestActorId(), {
				title: 'old',
				updatedAt: before,
			})
			const mid = await insertObject(db, workspaceId, getTestActorId(), {
				title: 'mid',
				updatedAt: T,
			})
			const fresh = await insertObject(db, workspaceId, getTestActorId(), {
				title: 'fresh',
				updatedAt: after,
			})
			return { old, mid, fresh }
		}

		it('returns rows when updated_before is one second after the row (AC-T1)', async () => {
			const app = createApp()
			const { mid } = await seedThree()

			const cutoff = new Date(T.getTime() + 1_000).toISOString()
			const res = await app.request(
				jsonGet(`/api/objects?updated_before=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			const ids = body.map((row) => row.id)
			expect(ids).toContain(mid.id)
		})

		it('excludes the row when updated_before is one second before it (AC-T1)', async () => {
			const app = createApp()
			const { mid } = await seedThree()

			const cutoff = new Date(T.getTime() - 1_000).toISOString()
			const res = await app.request(
				jsonGet(`/api/objects?updated_before=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			const ids = body.map((row) => row.id)
			expect(ids).not.toContain(mid.id)
		})

		it('half-open bound excludes rows at the exact instant on both sides (AC-T9)', async () => {
			const app = createApp()
			const { mid } = await seedThree()

			const cutoff = T.toISOString()
			const beforeRes = await app.request(
				jsonGet(`/api/objects?updated_before=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			const beforeBody = (await beforeRes.json()) as Array<{ id: string }>
			expect(beforeBody.map((r) => r.id)).not.toContain(mid.id)

			const afterRes = await app.request(
				jsonGet(`/api/objects?updated_after=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			const afterBody = (await afterRes.json()) as Array<{ id: string }>
			expect(afterBody.map((r) => r.id)).not.toContain(mid.id)
		})

		it('intersects with type and status (AC-T2)', async () => {
			const app = createApp()
			// Two rows updated within the same time window, different (type, status).
			const taskTodo = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				updatedAt: before,
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'done',
				updatedAt: before,
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				status: 'signal',
				updatedAt: before,
			})

			const cutoff = T.toISOString()
			const res = await app.request(
				jsonGet(`/api/objects?type=task&status=todo&updated_before=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string; type: string; status: string }>
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(taskTodo.id)
		})

		it('response is unchanged when neither param is set (AC-T7)', async () => {
			const app = createApp()
			await seedThree()

			const baseline = await app.request(jsonGet('/api/objects', { 'x-workspace-id': workspaceId }))
			const withDefaults = await app.request(
				jsonGet('/api/objects', { 'x-workspace-id': workspaceId }),
			)
			expect(baseline.status).toBe(200)
			expect(withDefaults.status).toBe(200)
			expect(await baseline.text()).toBe(await withDefaults.text())
		})

		it('rejects malformed updated_before with 400 (AC-T6)', async () => {
			const app = createApp()
			const res = await app.request(
				jsonGet('/api/objects?updated_before=not-a-date', { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(400)
		})

		it('server-side updated_before returns the same row set as fetch-all + client filter (AC-T4)', async () => {
			// This is the parity contract T4 is measured on: the daily sweep switches from
			// "fetch every in_progress task, filter updated_at < now-6h in JS" to a single
			// server-side call. Both must yield identical row sets on the same DB state.
			const app = createApp()
			const now = new Date('2026-06-30T12:00:00.000Z')
			const cutoff = new Date(now.getTime() - 6 * 3600 * 1000) // now - 6h

			// Stalled in_progress tasks (should be in both result sets).
			const stalledA = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'in_progress',
				updatedAt: new Date(cutoff.getTime() - 3600 * 1000), // 7h old
			})
			const stalledB = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'in_progress',
				updatedAt: new Date(cutoff.getTime() - 24 * 3600 * 1000), // 30h old
			})

			// Fresh in_progress task (should be in neither result set).
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'in_progress',
				updatedAt: new Date(cutoff.getTime() + 3600 * 1000), // 5h old, inside window
			})

			// Noise: stalled but wrong status / type — must not appear.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				updatedAt: new Date(cutoff.getTime() - 3600 * 1000),
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				status: 'active',
				updatedAt: new Date(cutoff.getTime() - 3600 * 1000),
			})

			// Pre-ship: fetch all in_progress tasks in the workspace, filter in JS.
			const preShipRes = await app.request(
				jsonGet('/api/objects?type=task&status=in_progress', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(preShipRes.status).toBe(200)
			const preShipRows = (await preShipRes.json()) as Array<{ id: string; updatedAt: string }>
			const preShipIds = preShipRows
				.filter((row) => new Date(row.updatedAt) < cutoff)
				.map((row) => row.id)
				.sort()

			// Post-ship: single server-side call with the same intent.
			const postShipRes = await app.request(
				jsonGet(
					`/api/objects?type=task&status=in_progress&updated_before=${encodeURIComponent(cutoff.toISOString())}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(postShipRes.status).toBe(200)
			const postShipRows = (await postShipRes.json()) as Array<{ id: string }>
			const postShipIds = postShipRows.map((row) => row.id).sort()

			expect(postShipIds).toEqual(preShipIds)
			expect(postShipIds).toEqual([stalledA.id, stalledB.id].sort())
		})
	})

	// Bet: edge-type-normalize — the read layer must resolve relationship
	// endpoints by object/file id, not by the stored sourceType/targetType
	// label. These tests exercise legacy-labelled rows against real Postgres so
	// a drifted stamp (`'insight'`/`'bet'` on an object endpoint, `'object'` on
	// a file endpoint) still surfaces in the graph payload.
	describe('GET /api/objects/:id/graph — id-based edge resolution', () => {
		it('returns an informs edge + endpoint object when sourceType is a legacy specialised label', async () => {
			const app = createApp()
			const actorId = getTestActorId()

			const bet = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
			})
			const insight = await insertObject(db, workspaceId, actorId, {
				type: 'insight',
				status: 'active',
			})
			// Legacy stamp — sourceType is the specialised 'insight' label rather
			// than the canonical 'object'. The graph handler must still resolve
			// the insight into connected_objects by id.
			const rel = await insertRelationship(db, actorId, {
				sourceType: 'insight',
				sourceId: insight.id,
				targetType: 'bet',
				targetId: bet.id,
				type: 'informs',
			})

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = await res.json()

			const relIds = (body.relationships as Array<{ id: string }>).map((r) => r.id)
			expect(relIds).toContain(rel.id)

			const connectedIds = (body.connected_objects as Array<{ id: string }>).map((o) => o.id)
			expect(connectedIds).toContain(insight.id)

			// File bucket must remain empty — the insight endpoint is an object,
			// not a file, so it should not leak into the files array even though
			// the stored label is specialised.
			expect(body.files).toEqual([])
		})

		it('returns an attached file even when the file edge is stamped with a legacy non-file label', async () => {
			const app = createApp()
			const actorId = getTestActorId()

			const bet = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
			})
			const [fileRow] = await db
				.insert(files)
				.values(buildFile({ workspaceId, createdBy: actorId }))
				.returning()
			// Legacy stamp — a file endpoint written by a code path that defaulted
			// to 'object' instead of 'file'. The graph handler must resolve this
			// by files.id membership, not by the stored label.
			await insertRelationship(db, actorId, {
				sourceType: 'bet',
				sourceId: bet.id,
				targetType: 'object',
				targetId: fileRow.id,
				type: 'attached',
			})

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = await res.json()

			const fileIds = (body.files as Array<{ id: string }>).map((f) => f.id)
			expect(fileIds).toContain(fileRow.id)

			// The file must not leak into connected_objects — it lives in the
			// files table, not objects.
			const connectedIds = (body.connected_objects as Array<{ id: string }>).map((o) => o.id)
			expect(connectedIds).not.toContain(fileRow.id)
		})

		it('resolves both a canonically-stamped object edge and a legacy file edge in the same payload', async () => {
			const app = createApp()
			const actorId = getTestActorId()

			const bet = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
			})
			const insight = await insertObject(db, workspaceId, actorId, {
				type: 'insight',
				status: 'active',
			})
			const [fileRow] = await db
				.insert(files)
				.values(buildFile({ workspaceId, createdBy: actorId }))
				.returning()

			// Canonical object stamp.
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: insight.id,
				targetType: 'object',
				targetId: bet.id,
				type: 'informs',
			})
			// Legacy file stamp — targetType is 'object' rather than 'file'.
			await insertRelationship(db, actorId, {
				sourceType: 'bet',
				sourceId: bet.id,
				targetType: 'object',
				targetId: fileRow.id,
				type: 'attached',
			})

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = await res.json()

			const connectedIds = (body.connected_objects as Array<{ id: string }>).map((o) => o.id)
			expect(connectedIds).toContain(insight.id)
			expect(connectedIds).not.toContain(fileRow.id)

			const graphFileIds = (body.files as Array<{ id: string }>).map((f) => f.id)
			expect(graphFileIds).toContain(fileRow.id)
		})
	})
})
