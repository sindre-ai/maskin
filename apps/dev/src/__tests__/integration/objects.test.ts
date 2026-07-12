import { events, files, objects, relationships } from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import {
	buildCreateObjectBody,
	buildFile,
	insertActor,
	insertObject,
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

		it("writes 'updated' events with data.changes and no legacy previous/updated snapshot", async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ title: 'Old' }), {
					'x-workspace-id': workspaceId,
				}),
			)
			const created = await createRes.json()

			await app.request(jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'New' }))

			const [updateEvent] = await db
				.select()
				.from(events)
				.where(eq(events.entityId, created.id))
				.orderBy(events.id)
				.offset(1)
				.limit(1)

			expect(updateEvent).toBeDefined()
			expect(updateEvent?.action).toBe('updated')
			const data = updateEvent?.data as {
				changes?: Array<{ field: string; old: unknown; new: unknown }>
				previous?: unknown
				updated?: unknown
			}
			expect(data.changes).toEqual([{ field: 'title', old: 'Old', new: 'New' }])
			expect(data.previous).toBeUndefined()
			expect(data.updated).toBeUndefined()
		})

		it("writes 'status_changed' events with a single-element data.changes on status-only edit", async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
			})

			await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, { status: 'in_progress' }),
			)

			// insertObject() writes the object row directly (no API call), so unlike
			// the 'updated' test above there's no preceding 'created' event to skip.
			const [statusEvent] = await db
				.select()
				.from(events)
				.where(eq(events.entityId, created.id))
				.orderBy(events.id)
				.limit(1)

			expect(statusEvent?.action).toBe('status_changed')
			const data = statusEvent?.data as {
				changes?: Array<{ field: string; old: unknown; new: unknown }>
			}
			expect(data.changes).toEqual([{ field: 'status', old: 'todo', new: 'in_progress' }])
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

		it('filters by metadata.<field>, matching only rows with that value', async () => {
			const app = createApp()

			const match = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				metadata: { segment: 'enterprise' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				metadata: { segment: 'smb' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				metadata: {},
			})

			const res = await app.request(
				jsonGet('/api/objects?metadata.segment=enterprise', { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id)).toEqual([match.id])
		})

		it('rejects an unsafe metadata.<field> name with 400 instead of a DB error', async () => {
			const app = createApp()

			const res = await app.request(
				jsonGet('/api/objects?metadata.bad-field=x', { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(400)
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

		it('applies a metadata.<field> filter to column totals and objects', async () => {
			const app = createApp()

			const match = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Human approved',
				metadata: { promotion_mode: 'human_approved' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				status: 'todo',
				title: 'Auto',
				metadata: { promotion_mode: 'auto' },
			})

			const res = await app.request(
				jsonGet('/api/objects/board?type=task&metadata.promotion_mode=human_approved', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			const todo = body.columns.find((column: { value: string }) => column.value === 'todo')
			expect(todo.total).toBe(1)
			expect(todo.objects.map((obj: { id: string }) => obj.id)).toEqual([match.id])
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

	describe('GET /api/objects/search — driver + updated_after filters', () => {
		it('filters by driver alongside q, returning only rows owned by that driver', async () => {
			const app = createApp()
			const alice = await insertActor(db)
			const bob = await insertActor(db)

			const aliceHit = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'checkout latency bet',
				driver: alice.id,
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'checkout latency bet',
				driver: bob.id,
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'signup drop-off bet',
				driver: alice.id,
			})

			const res = await app.request(
				jsonGet(`/api/objects/search?q=checkout&driver=${alice.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id).sort()).toEqual([aliceHit.id].sort())
		})

		it('excludes rows at or before updated_after (half-open bound)', async () => {
			const app = createApp()
			const T = new Date('2026-06-20T12:00:00.000Z')
			const before = new Date(T.getTime() - 60_000)
			const after = new Date(T.getTime() + 60_000)

			const oldHit = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'onboarding flow',
				updatedAt: before,
			})
			const freshHit = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'onboarding flow',
				updatedAt: after,
			})

			const cutoff = T.toISOString()
			const res = await app.request(
				jsonGet(`/api/objects/search?q=onboarding&updated_after=${encodeURIComponent(cutoff)}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			const ids = body.map((r) => r.id)
			expect(ids).toContain(freshHit.id)
			expect(ids).not.toContain(oldHit.id)
		})

		it('composes driver and updated_after additively with q and type', async () => {
			const app = createApp()
			const alice = await insertActor(db)
			const bob = await insertActor(db)
			const T = new Date('2026-06-20T12:00:00.000Z')
			const before = new Date(T.getTime() - 60_000)
			const after = new Date(T.getTime() + 60_000)

			// The only row matching all four predicates.
			const target = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'onboarding checklist',
				driver: alice.id,
				updatedAt: after,
			})
			// Wrong driver — should be excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'onboarding checklist',
				driver: bob.id,
				updatedAt: after,
			})
			// Right driver but stale — should be excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'onboarding checklist',
				driver: alice.id,
				updatedAt: before,
			})
			// Wrong type — should be excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding checklist',
				driver: alice.id,
				updatedAt: after,
			})
			// No text match — should be excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'task',
				title: 'billing dashboard',
				driver: alice.id,
				updatedAt: after,
			})

			const cutoff = T.toISOString()
			const res = await app.request(
				jsonGet(
					`/api/objects/search?q=onboarding&type=task&driver=${alice.id}&updated_after=${encodeURIComponent(cutoff)}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id)).toEqual([target.id])
		})

		it('rejects malformed updated_after with 400', async () => {
			const app = createApp()
			const res = await app.request(
				jsonGet('/api/objects/search?q=anything&updated_after=not-a-date', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/objects/search — metadata.<field> filters', () => {
		it('filters by a single metadata.<field>, excluding rows with a different value', async () => {
			const app = createApp()

			const match = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: { promotion_mode: 'human_approved' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: { promotion_mode: 'auto' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: {},
			})

			const res = await app.request(
				jsonGet('/api/objects/search?q=onboarding&metadata.promotion_mode=human_approved', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id)).toEqual([match.id])
		})

		it('composes multiple metadata.<field> filters additively (AND)', async () => {
			const app = createApp()

			const target = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: { promotion_mode: 'human_approved', evidence_quality: 'evidence_backed' },
			})
			// Right promotion_mode, wrong evidence_quality — excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: { promotion_mode: 'human_approved', evidence_quality: 'gut_feeling' },
			})
			// Wrong promotion_mode, right evidence_quality — excluded.
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'bet',
				title: 'onboarding revamp',
				metadata: { promotion_mode: 'auto', evidence_quality: 'evidence_backed' },
			})

			const res = await app.request(
				jsonGet(
					'/api/objects/search?q=onboarding&metadata.promotion_mode=human_approved&metadata.evidence_quality=evidence_backed',
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id)).toEqual([target.id])
		})

		it('does not require a type filter — metadata exists on every object type', async () => {
			const app = createApp()

			const match = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'insight',
				title: 'onboarding learnings',
				metadata: { theme: 'activation' },
			})
			await insertObject(db, workspaceId, getTestActorId(), {
				type: 'insight',
				title: 'onboarding learnings',
				metadata: { theme: 'retention' },
			})

			const res = await app.request(
				jsonGet('/api/objects/search?q=onboarding&metadata.theme=activation', {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: string }>
			expect(body.map((r) => r.id)).toEqual([match.id])
		})

		it('rejects an unsafe metadata.<field> name with 400 instead of a DB error', async () => {
			const app = createApp()

			const res = await app.request(
				jsonGet("/api/objects/search?q=onboarding&metadata.bad'field=x", {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(400)
		})
	})

	// AC-T3 — snapshot-consistent cursor pagination.
	//
	// The cursor carries an `snapshot_at` upper bound plus a `(created_at, id)`
	// keyset seek. Once the first page is fetched, every subsequent hop
	// forwards that snapshot so a row inserted into `objects` between page 1
	// and page 2 (via SQL, bypassing the API) cannot leak into the paginated
	// stream — no row is skipped or duplicated against the snapshot taken at
	// first call.
	describe('cursor pagination — snapshot consistency (AC-T3)', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createApp()
			const actorId = getTestActorId()

			// Seed 30 tasks with distinct, strictly increasing `createdAt`
			// so the (createdAt, id) keyset seek has no ties to resolve.
			// Sort order is `createdAt desc` (the API default), so newest first.
			const baseMs = new Date('2026-01-01T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; title: string; createdAt: Date }> = []
			for (let i = 0; i < 30; i++) {
				const created = await insertObject(db, workspaceId, actorId, {
					type: 'task',
					status: 'todo',
					title: `Seed ${String(i).padStart(2, '0')}`,
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
				seeded.push({ id: created.id, title: created.title, createdAt: created.createdAt })
			}

			// Snapshot boundary: anchor to the newest seeded row so any row
			// inserted after this point is provably outside the snapshot.
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			// Page 1 — 25 rows in `createdAt desc` order.
			const page1Res = await app.request(
				jsonGet(
					`/api/objects?type=task&limit=25&order=desc&sort=createdAt&snapshot_at=${encodeURIComponent(snapshotAt)}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(25)

			// Mid-pagination insert — SQL directly, with a `createdAt` after the
			// snapshot boundary. In a naïve offset scheme this would either
			// push all rows down by one (skip) or leave one row visible on both
			// pages (dup). The upper-bound filter keeps it out entirely.
			const intruder = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
				title: 'Mid-pagination intruder',
				createdAt: new Date(baseMs + 999 * 60_000),
				updatedAt: new Date(baseMs + 999 * 60_000),
			})

			// Page 2 — carry the same snapshot + keyset seek from the last row
			// of page 1. In desc order the seek predicate is
			// `(created_at, id) < (last_ca, last_id)`.
			const lastOfPage1 = page1[page1.length - 1]
			const page2Url = `/api/objects?type=task&limit=25&order=desc&sort=createdAt&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastOfPage1.createdAt)}&cursor_id=${encodeURIComponent(lastOfPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url, { 'x-workspace-id': workspaceId }))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string; createdAt: string }>

			// Snapshot has 30 rows; page 1 returned 25, page 2 must return the
			// remaining 5 and nothing else.
			expect(page2).toHaveLength(5)

			// No duplicate between page 1 and page 2.
			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) {
				expect(page1Ids.has(row.id)).toBe(false)
			}

			// Union equals the seeded set exactly — no skip, no leak.
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			const seededIds = seeded.map((r) => r.id).sort()
			expect([...walked].sort()).toEqual(seededIds)

			// The intruder — inserted after the snapshot — must NOT appear on
			// either page. That's the whole snapshot guarantee.
			expect(walked).not.toContain(intruder.id)
		})

		it('ignores the keyset seek when only cursor_id is passed without cursor_created_at', async () => {
			// A malformed cursor (id without its sort partner) must not silently
			// degrade to unbounded seek — the API treats it as "no cursor" and
			// returns the first page from the snapshot.
			const app = createApp()
			const actorId = getTestActorId()
			const baseMs = new Date('2026-02-01T00:00:00.000Z').getTime()
			for (let i = 0; i < 3; i++) {
				await insertObject(db, workspaceId, actorId, {
					type: 'task',
					status: 'todo',
					title: `Row ${i}`,
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
			}
			const snapshotAt = new Date(baseMs + 999 * 60_000).toISOString()

			const nilId = '00000000-0000-0000-0000-000000000000'
			const url = `/api/objects?type=task&limit=10&order=desc&sort=createdAt&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_id=${encodeURIComponent(nilId)}`
			const res = await app.request(jsonGet(url, { 'x-workspace-id': workspaceId }))
			expect(res.status).toBe(200)
			const rows = (await res.json()) as Array<{ id: string }>
			expect(rows).toHaveLength(3)
		})

		it('ignores the keyset seek when sort does not resolve to createdAt', async () => {
			// The `(created_at, id)` keyset seek only produces a result set
			// consistent with the ORDER BY when the walk is actually sorted by
			// createdAt. Pairing a `sort=updatedAt` walk with a cursor built from
			// a createdAt/id tuple would filter on a column unrelated to the
			// ORDER BY — silently dropping rows whose createdAt/updatedAt rank
			// disagree. Row 2 here is created last but updated first, so a
			// createdAt-based seek anchored on row 1 would wrongly exclude it.
			const app = createApp()
			const actorId = getTestActorId()
			const baseMs = new Date('2026-02-02T00:00:00.000Z').getTime()

			const row0 = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
				title: 'Row 0 — oldest created, most recently updated',
				createdAt: new Date(baseMs),
				updatedAt: new Date(baseMs + 300 * 60_000),
			})
			const row1 = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
				title: 'Row 1 — cursor anchor',
				createdAt: new Date(baseMs + 60_000),
				updatedAt: new Date(baseMs + 200 * 60_000),
			})
			const row2 = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
				title: 'Row 2 — newest created, least recently updated',
				createdAt: new Date(baseMs + 120_000),
				updatedAt: new Date(baseMs + 100 * 60_000),
			})

			// Cursor anchored on row 1's (createdAt, id) — as if a prior page had
			// been walked in createdAt order — combined with `sort=updatedAt`.
			const url = `/api/objects?type=task&limit=10&order=desc&sort=updatedAt&cursor_created_at=${encodeURIComponent(row1.createdAt.toISOString())}&cursor_id=${encodeURIComponent(row1.id)}`
			const res = await app.request(jsonGet(url, { 'x-workspace-id': workspaceId }))
			expect(res.status).toBe(200)
			const rows = (await res.json()) as Array<{ id: string; updatedAt: string }>

			// A createdAt-based seek would incorrectly exclude row2 (createdAt is
			// not strictly less than row1's) even though row2 legitimately sorts
			// after row1 in updatedAt-desc order. The seek must be skipped
			// entirely, so all three rows are returned, ordered by updatedAt desc.
			expect(rows.map((r) => r.id)).toEqual([row0.id, row1.id, row2.id])
		})
	})

	describe('GET /api/objects/:id/graph — endpoint resolution by id', () => {
		it('surfaces an edge and resolves its connected object by id', async () => {
			// The read layer resolves endpoints by object/file id, not by the
			// stored `sourceType`/`targetType` label. The DB CHECK constraint
			// blocks non-canonical labels at write time, and the route unit tests
			// (objects.test.ts, `resolves an edge whose sourceType label does not
			// match the endpoint kind`) cover the legacy-label scenario with mocks.
			// This integration test validates the id-based resolution mechanism
			// against a real database with canonical types.
			const app = createApp()
			const bet = await insertObject(db, workspaceId, getTestActorId(), { type: 'bet' })
			const insight = await insertObject(db, workspaceId, getTestActorId(), { type: 'insight' })
			await db.insert(relationships).values({
				sourceType: 'object',
				sourceId: insight.id,
				targetType: 'object',
				targetId: bet.id,
				type: 'informs',
				createdBy: getTestActorId(),
			})

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': workspaceId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.relationships).toHaveLength(1)
			expect(body.relationships[0].sourceId).toBe(insight.id)
			expect(body.relationships[0].type).toBe('informs')
			expect(body.connected_objects).toHaveLength(1)
			expect(body.connected_objects[0].id).toBe(insight.id)
			expect(body.files).toEqual([])
		})

		it('buckets a file endpoint correctly with canonical target_type', async () => {
			// An `attached` edge whose target endpoint is a file. The read layer
			// resolves endpoints by id lookup against the `files` table, so the
			// attachment lands in `files` regardless of what type label the edge
			// carries. Since the DB CHECK constraint now enforces canonical labels
			// at write time, we use `targetType: 'file'` here. The route unit test
			// (`resolves a file endpoint even when the edge label is a legacy
			// object type`) covers the legacy-label scenario with mocks.
			const app = createApp()
			const bet = await insertObject(db, workspaceId, getTestActorId(), { type: 'bet' })
			const [fileRow] = await db
				.insert(files)
				.values(buildFile({ workspaceId, createdBy: getTestActorId() }))
				.returning()
			await db.insert(relationships).values({
				sourceType: 'object',
				sourceId: bet.id,
				targetType: 'file',
				targetId: fileRow.id,
				type: 'attached',
				createdBy: getTestActorId(),
			})

			const res = await app.request(
				jsonGet(`/api/objects/${bet.id}/graph`, { 'x-workspace-id': workspaceId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.connected_objects).toEqual([])
			expect(body.files).toHaveLength(1)
			expect(body.files[0].id).toBe(fileRow.id)
		})
	})

	describe('GET /api/objects/:id/references — 7-day rolling reference count', () => {
		// Load-bearing integration test for T6: the DoD contract that emitting
		// N reference events across M unique sessions returns M. The unit test
		// pins the response shape against the mock aggregate; this test pins
		// the actual DISTINCT semantics against real Postgres — mocked DB
		// tests can't catch `data->>'consumer_context_id'` DISTINCT
		// misbehaviour (or a filter that quietly full-scans).
		it('counts DISTINCT consumer_context_id values (7-day window) for the specified action', async () => {
			const knowledge = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'knowledge',
			})
			const consumerA = await insertObject(db, workspaceId, getTestActorId(), { type: 'bet' })
			const consumerB = await insertObject(db, workspaceId, getTestActorId(), { type: 'task' })
			const consumerC = await insertObject(db, workspaceId, getTestActorId(), { type: 'insight' })

			// 4 reference events across 3 unique consumer contexts — expect N=3.
			// consumerA gets two rows to prove the DISTINCT collapse.
			const rows = [
				{ consumer_context_id: consumerA.id },
				{ consumer_context_id: consumerA.id },
				{ consumer_context_id: consumerB.id },
				{ consumer_context_id: consumerC.id },
			]
			for (const r of rows) {
				await db.insert(events).values({
					workspaceId,
					actorId: getTestActorId(),
					action: 'workspace_knowledge_referenced',
					entityType: 'object',
					entityId: knowledge.id,
					data: { consumer_context_id: r.consumer_context_id, source_topics: [] },
				})
			}

			// Guard: an unrelated action on the same entity must not inflate the
			// count — the WHERE clause pins the action.
			await db.insert(events).values({
				workspaceId,
				actorId: getTestActorId(),
				action: 'commented',
				entityType: 'object',
				entityId: knowledge.id,
				data: { consumer_context_id: consumerA.id },
			})

			const app = createApp()
			const res = await app.request(
				jsonGet(`/api/objects/${knowledge.id}/references`, {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.window_days).toBe(7)
			expect(body.unique_contexts).toBe(3)
		})

		it('excludes rows outside the 7-day window', async () => {
			const knowledge = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'knowledge',
			})
			const consumerA = await insertObject(db, workspaceId, getTestActorId(), { type: 'bet' })
			const consumerB = await insertObject(db, workspaceId, getTestActorId(), { type: 'task' })

			// One row inside the window (default `createdAt` = now via the
			// column default), one row backdated 30 days out. Only the in-window
			// row must be counted.
			await db.insert(events).values({
				workspaceId,
				actorId: getTestActorId(),
				action: 'workspace_knowledge_referenced',
				entityType: 'object',
				entityId: knowledge.id,
				data: { consumer_context_id: consumerA.id, source_topics: [] },
			})
			const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
			await db.insert(events).values({
				workspaceId,
				actorId: getTestActorId(),
				action: 'workspace_knowledge_referenced',
				entityType: 'object',
				entityId: knowledge.id,
				data: { consumer_context_id: consumerB.id, source_topics: [] },
				createdAt: thirtyDaysAgo,
			})

			const app = createApp()
			const res = await app.request(
				jsonGet(`/api/objects/${knowledge.id}/references`, {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.unique_contexts).toBe(1)
		})

		it('returns 0 when no reference events exist for the object', async () => {
			const knowledge = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'knowledge',
			})

			const app = createApp()
			const res = await app.request(
				jsonGet(`/api/objects/${knowledge.id}/references`, {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.unique_contexts).toBe(0)
			expect(body.window_days).toBe(7)
		})

		it('scopes the count to the current workspace', async () => {
			const knowledge = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'knowledge',
			})
			const consumer = await insertObject(db, workspaceId, getTestActorId(), { type: 'bet' })
			// A second workspace holds an event with the SAME entity_id — the
			// endpoint filters by workspace_id so this must not leak into the
			// count.
			const otherWs = await insertWorkspace(db, getTestActorId())
			await db.insert(events).values({
				workspaceId: otherWs.id,
				actorId: getTestActorId(),
				action: 'workspace_knowledge_referenced',
				entityType: 'object',
				entityId: knowledge.id,
				data: { consumer_context_id: consumer.id, source_topics: [] },
			})

			const app = createApp()
			const res = await app.request(
				jsonGet(`/api/objects/${knowledge.id}/references`, {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.unique_contexts).toBe(0)
		})
	})
})
