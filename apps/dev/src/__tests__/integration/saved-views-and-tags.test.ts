import { OpenAPIHono } from '@hono/zod-openapi'
import {
	events,
	actors,
	conversationParticipants,
	conversations,
	savedViews,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { ViewerReadOnlyError } from '../../lib/workspace-auth'
import { insertActor, insertConversation, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: conversationsRoutes } = await import('../../routes/conversations')
const { default: savedViewsRoutes } = await import('../../routes/saved-views')

async function addMember(
	workspaceId: string,
	name: string,
	type: 'agent' | 'human' = 'agent',
	role = 'member',
) {
	const actor = await insertActor(db, { type, name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role })
	return actor
}

const ws = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

describe('Tags on agents', () => {
	it('sets, reads and replaces an agent’s tags, and keeps its other metadata', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const agent = await addMember(workspace.id, 'Tagged')
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true, avatar_version: 3 } })
			.where(eq(actors.id, agent.id))

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ tags: ['Sales', ' sales ', 'EU'] },
				ws(workspace.id),
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tags: string[]; voice_enabled: boolean }
		expect(body.tags).toEqual(['Sales', 'EU'])
		expect(body.voice_enabled).toBe(true)

		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, agent.id))
		expect(row.metadata).toEqual({ voice_enabled: true, avatar_version: 3, tags: ['Sales', 'EU'] })

		const get = await app.request(jsonGet(`/api/actors/${agent.id}`, ws(workspace.id)))
		expect(((await get.json()) as { tags: string[] }).tags).toEqual(['Sales', 'EU'])

		const list = await app.request(jsonGet('/api/actors', ws(workspace.id)))
		const rows = (await list.json()) as Array<{ id: string; tags: string[] }>
		expect(rows.find((r) => r.id === agent.id)?.tags).toEqual(['Sales', 'EU'])

		const replaced = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tags: ['Support'] }, ws(workspace.id)),
		)
		expect(((await replaced.json()) as { tags: string[] }).tags).toEqual(['Support'])
		const cleared = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tags: [] }, ws(workspace.id)),
		)
		expect(((await cleared.json()) as { tags: string[] }).tags).toEqual([])
	})

	it('records an event for a tag change, and none for a plain rename', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Audited')

		await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { name: 'Renamed' }, ws(workspace.id)),
		)
		await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tags: ['Ops'] }, ws(workspace.id)),
		)
		const rows = await db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityId, agent.id), eq(events.action, 'actor_tags_updated')))
		expect(rows).toHaveLength(1)
		expect((rows[0].data as { tags: string[] }).tags).toEqual(['Ops'])
	})

	it('refuses too many tags, a too long tag, a tag on a person, and tags without a workspace', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Strict')
		const person = await addMember(workspace.id, 'Hannah', 'human')
		const patch = (id: string, body: unknown, headers: Record<string, string> = ws(workspace.id)) =>
			app.request(jsonRequest('PATCH', `/api/actors/${id}`, body, headers))

		const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`)
		expect((await patch(agent.id, { tags: eleven })).status).toBe(400)
		expect((await patch(agent.id, { tags: ['x'.repeat(41)] })).status).toBe(400)
		expect((await patch(agent.id, { tags: [''] })).status).toBe(400)
		expect((await patch(person.id, { tags: ['Sales'] })).status).toBe(400)
		expect((await patch(agent.id, { tags: ['Sales'] }, {})).status).toBe(400)

		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, agent.id))
		expect(row.metadata ?? {}).not.toHaveProperty('tags')
	})

	it('reads an agent with no tags as an empty list', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Untagged')
		const get = await app.request(jsonGet(`/api/actors/${agent.id}`, ws(workspace.id)))
		expect(((await get.json()) as { tags: string[] }).tags).toEqual([])
	})
})

describe('Tags on chats', () => {
	async function chatFor(workspaceId: string, actorId: string, overrides = {}) {
		const chat = await insertConversation(db, workspaceId, actorId, overrides)
		await db.insert(conversationParticipants).values({ conversationId: chat.id, actorId })
		return chat
	}

	it('sets tags on a chat without touching its title, and shows them in the list and detail', async () => {
		const app = createIntegrationApp({ path: '/api/conversations', module: conversationsRoutes })
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const chat = await chatFor(workspace.id, owner, { title: 'Quarter plan' })

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/conversations/${chat.id}`,
				{ tags: ['Sales', 'sales', 'Q4'] },
				ws(workspace.id),
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { title: string; tags: string[] }
		expect(body.title).toBe('Quarter plan')
		expect(body.tags).toEqual(['Sales', 'Q4'])

		const [row] = await db.select().from(conversations).where(eq(conversations.id, chat.id))
		expect(row.titleAutoState).toBe('none')

		const detail = await app.request(jsonGet(`/api/conversations/${chat.id}`, ws(workspace.id)))
		expect(((await detail.json()) as { tags: string[] }).tags).toEqual(['Sales', 'Q4'])
		const list = await app.request(jsonGet('/api/conversations', ws(workspace.id)))
		const listed = (await list.json()) as { conversations: Array<{ id: string; tags: string[] }> }
		expect(listed.conversations.find((c) => c.id === chat.id)?.tags).toEqual(['Sales', 'Q4'])
	})

	it('still renames with a title alone, and a title plus tags changes both', async () => {
		const app = createIntegrationApp({ path: '/api/conversations', module: conversationsRoutes })
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const chat = await chatFor(workspace.id, owner)

		const renamed = await app.request(
			jsonRequest(
				'PATCH',
				`/api/conversations/${chat.id}`,
				{ title: 'New name' },
				ws(workspace.id),
			),
		)
		const renamedBody = (await renamed.json()) as { title: string; tags: string[] }
		expect(renamedBody.title).toBe('New name')
		expect(renamedBody.tags).toEqual([])
		const [afterRename] = await db.select().from(conversations).where(eq(conversations.id, chat.id))
		expect(afterRename.titleAutoState).toBe('manual')

		const both = await app.request(
			jsonRequest(
				'PATCH',
				`/api/conversations/${chat.id}`,
				{ title: 'Again', tags: ['Ops'] },
				ws(workspace.id),
			),
		)
		const bothBody = (await both.json()) as { title: string; tags: string[] }
		expect(bothBody).toMatchObject({ title: 'Again', tags: ['Ops'] })
	})

	it('refuses an empty change, bad tags, and a chat the caller is not in', async () => {
		const app = createIntegrationApp({ path: '/api/conversations', module: conversationsRoutes })
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const mine = await chatFor(workspace.id, owner)
		const theirs = await insertConversation(db, workspace.id, owner)
		const patch = (id: string, body: unknown) =>
			app.request(jsonRequest('PATCH', `/api/conversations/${id}`, body, ws(workspace.id)))

		expect((await patch(mine.id, {})).status).toBe(400)
		expect(
			(await patch(mine.id, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status,
		).toBe(400)
		expect((await patch(mine.id, { tags: ['x'.repeat(41)] })).status).toBe(400)
		expect((await patch(theirs.id, { tags: ['Sales'] })).status).toBe(404)
	})
})

describe('Saved views', () => {
	function viewsApp(role?: string) {
		const app = new OpenAPIHono<{
			Variables: { db: typeof db; actorId: string; actorType: string; workspaceRole?: string }
		}>({
			defaultHook: (result, c) => {
				if (!result.success) {
					return c.json(
						createApiError(
							'VALIDATION_ERROR',
							'Request validation failed',
							formatZodError(result.error),
						),
						400,
					)
				}
				return undefined
			},
		})
		app.onError((err, c) => {
			if (err instanceof ViewerReadOnlyError)
				return c.json(createApiError('FORBIDDEN', err.message), 403)
			throw err
		})
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', getTestActorId())
			c.set('actorType', 'human')
			if (role) c.set('workspaceRole', role)
			await next()
		})
		app.route('/api/saved-views', savedViewsRoutes)
		return app
	}

	const create = (app: ReturnType<typeof viewsApp>, workspaceId: string, body: unknown) =>
		app.request(jsonRequest('POST', '/api/saved-views', body, ws(workspaceId)))

	it('creates, lists, applies and deletes a view for agents', async () => {
		const app = viewsApp()
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const sales = await addMember(workspace.id, 'Ada')
		const salesEu = await addMember(workspace.id, 'Bo')
		const support = await addMember(workspace.id, 'Cy')
		const untagged = await addMember(workspace.id, 'Di')
		const person = await addMember(workspace.id, 'Hannah', 'human')
		await db
			.update(actors)
			.set({ metadata: { tags: ['Sales'] } })
			.where(eq(actors.id, sales.id))
		await db
			.update(actors)
			.set({ metadata: { tags: ['sales', 'EU'] } })
			.where(eq(actors.id, salesEu.id))
		await db
			.update(actors)
			.set({ metadata: { tags: ['Support'] } })
			.where(eq(actors.id, support.id))
		await db
			.update(actors)
			.set({ metadata: { tags: ['Sales'] } })
			.where(eq(actors.id, person.id))

		const created = await create(app, workspace.id, {
			name: 'By team',
			kind: 'agent',
			filter: {},
			groupBy: 'tag',
		})
		expect(created.status).toBe(201)
		const view = (await created.json()) as {
			id: string
			name: string
			kind: string
			createdBy: string
		}
		expect(view).toMatchObject({ name: 'By team', kind: 'agent', createdBy: owner })

		const listed = await app.request(jsonGet('/api/saved-views', ws(workspace.id)))
		expect(
			((await listed.json()) as { views: Array<{ id: string }> }).views.map((v) => v.id),
		).toEqual([view.id])

		const applied = await app.request(
			jsonGet(`/api/saved-views/${view.id}/apply`, ws(workspace.id)),
		)
		expect(applied.status).toBe(200)
		const { groups } = (await applied.json()) as {
			groups: Array<{ key: string | null; ids: string[] }>
		}
		expect(groups).toEqual([
			{ key: 'EU', ids: [salesEu.id] },
			{ key: 'Sales', ids: [sales.id, salesEu.id] },
			{ key: 'Support', ids: [support.id] },
			{ key: null, ids: [untagged.id] },
		])

		const del = await app.request(jsonDelete(`/api/saved-views/${view.id}`, ws(workspace.id)))
		expect(del.status).toBe(200)
		const after = await app.request(jsonGet('/api/saved-views', ws(workspace.id)))
		expect(((await after.json()) as { views: unknown[] }).views).toEqual([])
		expect(
			(await app.request(jsonGet(`/api/saved-views/${view.id}/apply`, ws(workspace.id)))).status,
		).toBe(404)
	})

	it('filters agents by tag when a view carries one', async () => {
		const app = viewsApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const a = await addMember(workspace.id, 'Ada')
		const b = await addMember(workspace.id, 'Bo')
		await db
			.update(actors)
			.set({ metadata: { tags: ['Sales', 'EU'] } })
			.where(eq(actors.id, a.id))
		await db
			.update(actors)
			.set({ metadata: { tags: ['Sales'] } })
			.where(eq(actors.id, b.id))

		const res = await create(app, workspace.id, {
			name: 'EU sales',
			kind: 'agent',
			filter: { tags: ['sales', 'eu'] },
		})
		const view = (await res.json()) as { id: string; groupBy: string | null }
		expect(view.groupBy).toBeNull()
		const applied = await app.request(
			jsonGet(`/api/saved-views/${view.id}/apply`, ws(workspace.id)),
		)
		expect(((await applied.json()) as { groups: unknown }).groups).toEqual([
			{ key: null, ids: [a.id] },
		])
	})

	it('applies a chat view to the caller’s own, unarchived chats only', async () => {
		const app = viewsApp()
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const other = await addMember(workspace.id, 'Other', 'human')
		const mine = await insertConversation(db, workspace.id, owner, { tags: ['Sales'] })
		const archived = await insertConversation(db, workspace.id, owner, { tags: ['Sales'] })
		const left = await insertConversation(db, workspace.id, owner, { tags: ['Sales'] })
		const notMine = await insertConversation(db, workspace.id, other.id, { tags: ['Sales'] })
		await db.insert(conversationParticipants).values([
			{ conversationId: mine.id, actorId: owner },
			{ conversationId: archived.id, actorId: owner, archived: true },
			{ conversationId: left.id, actorId: owner, leftAt: new Date() },
			{ conversationId: notMine.id, actorId: other.id },
		])

		const res = await create(app, workspace.id, {
			name: 'Sales chats',
			kind: 'chat',
			filter: { tags: ['Sales'] },
		})
		const view = (await res.json()) as { id: string }
		const applied = await app.request(
			jsonGet(`/api/saved-views/${view.id}/apply`, ws(workspace.id)),
		)
		expect(((await applied.json()) as { groups: unknown }).groups).toEqual([
			{ key: null, ids: [mine.id] },
		])
	})

	it('applies a flow view with a driver filter and groups flows by driver', async () => {
		const app = viewsApp()
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const driver = await addMember(workspace.id, 'Driver')
		const driven = await insertObject(db, workspace.id, owner, {
			type: 'loop',
			title: 'Driven flow',
			driver: driver.id,
			metadata: { tags: ['Sales'] },
		})
		const loose = await insertObject(db, workspace.id, owner, { type: 'loop', title: 'Loose flow' })

		const filtered = await create(app, workspace.id, {
			name: 'Mine',
			kind: 'flow',
			filter: { driverId: driver.id },
		})
		const filteredView = (await filtered.json()) as { id: string }
		const a = await app.request(
			jsonGet(`/api/saved-views/${filteredView.id}/apply`, ws(workspace.id)),
		)
		expect(((await a.json()) as { groups: unknown }).groups).toEqual([
			{ key: null, ids: [driven.id] },
		])

		const grouped = await create(app, workspace.id, {
			name: 'By driver',
			kind: 'flow',
			groupBy: 'driver',
		})
		const groupedView = (await grouped.json()) as { id: string }
		const b = await app.request(
			jsonGet(`/api/saved-views/${groupedView.id}/apply`, ws(workspace.id)),
		)
		expect(((await b.json()) as { groups: unknown }).groups).toEqual([
			{ key: driver.id, ids: [driven.id] },
			{ key: null, ids: [loose.id] },
		])
	})

	it('refuses a duplicate name per kind whatever the capitalisation, but allows it for another kind', async () => {
		const app = viewsApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		expect((await create(app, workspace.id, { name: 'Teams', kind: 'agent' })).status).toBe(201)
		expect((await create(app, workspace.id, { name: ' teams ', kind: 'agent' })).status).toBe(409)
		expect((await create(app, workspace.id, { name: 'Teams', kind: 'chat' })).status).toBe(201)
		const rows = await db.select().from(savedViews).where(eq(savedViews.workspaceId, workspace.id))
		expect(rows).toHaveLength(2)
	})

	it('refuses a driver on an agent or chat view, a bad kind, and a bad name', async () => {
		const app = viewsApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const driverId = crypto.randomUUID()
		expect(
			(await create(app, workspace.id, { name: 'x', kind: 'agent', filter: { driverId } })).status,
		).toBe(400)
		expect(
			(await create(app, workspace.id, { name: 'x', kind: 'chat', groupBy: 'driver' })).status,
		).toBe(400)
		expect((await create(app, workspace.id, { name: 'x', kind: 'object' })).status).toBe(400)
		expect((await create(app, workspace.id, { name: ' ', kind: 'agent' })).status).toBe(400)
		expect((await create(app, workspace.id, { name: 'x'.repeat(61), kind: 'agent' })).status).toBe(
			400,
		)
		expect(
			(await create(app, workspace.id, { name: 'x', kind: 'agent', filter: { sort: 'name' } }))
				.status,
		).toBe(400)
		expect(
			(
				await create(app, workspace.id, {
					name: 'x',
					kind: 'agent',
					filter: { tags: ['a'.repeat(41)] },
				})
			).status,
		).toBe(400)
	})

	it('lists by kind and keeps views inside their own workspace', async () => {
		const app = viewsApp()
		const owner = getTestActorId()
		const one = await insertWorkspace(db, owner)
		const two = await insertWorkspace(db, owner)
		const agentView = (await (await create(app, one.id, { name: 'A', kind: 'agent' })).json()) as {
			id: string
		}
		await create(app, one.id, { name: 'C', kind: 'chat' })
		await create(app, two.id, { name: 'Other', kind: 'agent' })

		const byKind = await app.request(jsonGet('/api/saved-views?kind=agent', ws(one.id)))
		expect(
			((await byKind.json()) as { views: Array<{ name: string }> }).views.map((v) => v.name),
		).toEqual(['A'])
		const all = await app.request(jsonGet('/api/saved-views', ws(one.id)))
		expect(((await all.json()) as { views: unknown[] }).views).toHaveLength(2)

		// Another workspace can neither apply nor delete it.
		expect(
			(await app.request(jsonGet(`/api/saved-views/${agentView.id}/apply`, ws(two.id)))).status,
		).toBe(404)
		expect(
			(await app.request(jsonDelete(`/api/saved-views/${agentView.id}`, ws(two.id)))).status,
		).toBe(404)
		expect(await db.select().from(savedViews).where(eq(savedViews.id, agentView.id))).toHaveLength(
			1,
		)
	})

	it('lets a viewer read but not create or delete', async () => {
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const existing = (await (
			await create(viewsApp(), workspace.id, { name: 'Shared', kind: 'agent' })
		).json()) as { id: string }

		const viewer = viewsApp('viewer')
		expect((await create(viewer, workspace.id, { name: 'Mine', kind: 'agent' })).status).toBe(403)
		expect(
			(await viewer.request(jsonDelete(`/api/saved-views/${existing.id}`, ws(workspace.id))))
				.status,
		).toBe(403)
		expect((await viewer.request(jsonGet('/api/saved-views', ws(workspace.id)))).status).toBe(200)
		expect(
			(await viewer.request(jsonGet(`/api/saved-views/${existing.id}/apply`, ws(workspace.id))))
				.status,
		).toBe(200)
	})

	it('stops a workspace at 100 views', async () => {
		const app = viewsApp()
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		await db.insert(savedViews).values(
			Array.from({ length: 100 }, (_, i) => ({
				workspaceId: workspace.id,
				kind: 'agent',
				name: `View ${i}`,
				createdBy: owner,
			})),
		)
		expect((await create(app, workspace.id, { name: 'One too many', kind: 'agent' })).status).toBe(
			409,
		)
	})

	it('keeps a view when its author is deleted', async () => {
		const owner = getTestActorId()
		const workspace = await insertWorkspace(db, owner)
		const author = await insertActor(db, { type: 'human' })
		const [view] = await db
			.insert(savedViews)
			.values({ workspaceId: workspace.id, kind: 'agent', name: 'Orphan', createdBy: author.id })
			.returning()

		await db.delete(actors).where(eq(actors.id, author.id))
		const [kept] = await db.select().from(savedViews).where(eq(savedViews.id, view.id))
		expect(kept.createdBy).toBeNull()
	})

	it('rejects a kind or group-by outside the allowed values at the database', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		await expect(
			db.insert(savedViews).values({ workspaceId: workspace.id, kind: 'object', name: 'Bad kind' }),
		).rejects.toThrow()
		await expect(
			db
				.insert(savedViews)
				.values({ workspaceId: workspace.id, kind: 'agent', name: 'Bad group', groupBy: 'status' }),
		).rejects.toThrow()
	})
})
