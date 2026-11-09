import { events, workspaceMembers } from '@maskin/db/schema'
import {
	buildEvent,
	insertActor,
	insertObject,
	insertSession,
	insertSessionLog,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

async function setup() {
	const ws = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent', name: 'Worker' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	return { ws, agent }
}

const headers = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

describe('GET /api/actors/:id/objects', () => {
	it('returns objects the agent created, drives or changed, newest first, and nothing else', async () => {
		const { ws, agent } = await setup()
		const created = await insertObject(db, ws.id, agent.id, {
			title: 'Created',
			updatedAt: new Date('2026-11-01T00:00:00.000Z'),
		})
		const driven = await insertObject(db, ws.id, getTestActorId(), {
			title: 'Driven',
			driver: agent.id,
			updatedAt: new Date('2026-11-03T00:00:00.000Z'),
		})
		const changed = await insertObject(db, ws.id, getTestActorId(), {
			title: 'Changed',
			updatedAt: new Date('2026-11-02T00:00:00.000Z'),
		})
		const untouched = await insertObject(db, ws.id, getTestActorId(), { title: 'Untouched' })
		const commentedOnly = await insertObject(db, ws.id, getTestActorId(), { title: 'Commented' })
		await db.insert(events).values([
			buildEvent({
				workspaceId: ws.id,
				actorId: agent.id,
				action: 'status_changed',
				entityType: 'task',
				entityId: changed.id,
			}),
			buildEvent({
				workspaceId: ws.id,
				actorId: agent.id,
				action: 'commented',
				entityType: 'task',
				entityId: commentedOnly.id,
			}),
		])

		const res = await createApp().request(
			jsonGet(`/api/actors/${agent.id}/objects`, headers(ws.id)),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { items: Array<{ id: string }>; hasMore: boolean }
		expect(body.items.map((i) => i.id)).toEqual([driven.id, changed.id, created.id])
		expect(body.hasMore).toBe(false)
		expect(body.items.map((i) => i.id)).not.toContain(untouched.id)
	})

	it('pages with limit and offset', async () => {
		const { ws, agent } = await setup()
		for (let i = 0; i < 3; i++) {
			await insertObject(db, ws.id, agent.id, {
				updatedAt: new Date(`2026-11-0${i + 1}T00:00:00.000Z`),
			})
		}

		const first = await createApp().request(
			jsonGet(`/api/actors/${agent.id}/objects?limit=2`, headers(ws.id)),
		)
		const second = await createApp().request(
			jsonGet(`/api/actors/${agent.id}/objects?limit=2&offset=2`, headers(ws.id)),
		)

		const a = (await first.json()) as { items: unknown[]; hasMore: boolean }
		const b = (await second.json()) as { items: unknown[]; hasMore: boolean }
		expect([a.items.length, a.hasMore]).toEqual([2, true])
		expect([b.items.length, b.hasMore]).toEqual([1, false])
	})

	it("never shows another workspace's objects, even ones the agent changed there", async () => {
		const { ws, agent } = await setup()
		const otherWs = await insertWorkspace(db, getTestActorId())
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: otherWs.id, actorId: agent.id, role: 'member' })
		const elsewhere = await insertObject(db, otherWs.id, agent.id)
		await db.insert(events).values(
			buildEvent({
				workspaceId: otherWs.id,
				actorId: agent.id,
				action: 'updated',
				entityType: 'task',
				entityId: elsewhere.id,
			}),
		)

		const res = await createApp().request(
			jsonGet(`/api/actors/${agent.id}/objects`, headers(ws.id)),
		)

		expect(((await res.json()) as { items: unknown[] }).items).toEqual([])
	})

	it('returns 404 for an actor outside the workspace', async () => {
		const { ws } = await setup()
		const outsider = await insertActor(db, { type: 'agent' })

		const res = await createApp().request(
			jsonGet(`/api/actors/${outsider.id}/objects`, headers(ws.id)),
		)

		expect(res.status).toBe(404)
	})
})

describe('GET /api/actors/:id/working-now', () => {
	const workingNow = async (agentId: string, workspaceId: string) => {
		const res = await createApp().request(
			jsonGet(`/api/actors/${agentId}/working-now`, headers(workspaceId)),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { workingNow: Record<string, unknown> | null }).workingNow
	}

	it('is null for an agent with no session', async () => {
		const { ws, agent } = await setup()
		expect(await workingNow(agent.id, ws.id)).toBeNull()
	})

	it('is null when the agent only has finished sessions', async () => {
		const { ws, agent } = await setup()
		await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'completed',
			currentActivity: 'Old news',
		})
		expect(await workingNow(agent.id, ws.id)).toBeNull()
	})

	it('shows the activity line of a running one-shot session, cut to the push length', async () => {
		const { ws, agent } = await setup()
		await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'running',
			currentActivity: 'x'.repeat(200),
		})

		const now = await workingNow(agent.id, ws.id)

		expect((now?.doing as string).length).toBe(80)
		expect(now).not.toHaveProperty('topic')
	})

	it('falls back to "working" when the session has no activity line', async () => {
		const { ws, agent } = await setup()
		await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'running',
			currentActivity: null,
		})
		expect(await workingNow(agent.id, ws.id)).toMatchObject({ doing: 'working' })
	})

	it('reads a chat session per turn: working mid-turn, null once the turn has closed', async () => {
		const { ws, agent } = await setup()
		const chat = await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'running',
			interactive: true,
			currentActivity: 'Reading the brief',
		})
		await insertSessionLog(db, chat.id, { content: '{"type":"assistant"}' })
		expect(await workingNow(agent.id, ws.id)).toMatchObject({ doing: 'Reading the brief' })

		await insertSessionLog(db, chat.id, { content: '{"type":"result"}' })
		expect(await workingNow(agent.id, ws.id)).toBeNull()

		await insertSessionLog(db, chat.id, { content: '{"type":"assistant"}' })
		expect(await workingNow(agent.id, ws.id)).toMatchObject({ doing: 'Reading the brief' })
	})

	it("does not show another workspace's session", async () => {
		const { ws, agent } = await setup()
		const otherWs = await insertWorkspace(db, getTestActorId())
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: otherWs.id, actorId: agent.id, role: 'member' })
		await insertSession(db, otherWs.id, agent.id, getTestActorId(), { status: 'running' })

		expect(await workingNow(agent.id, ws.id)).toBeNull()
	})
})
