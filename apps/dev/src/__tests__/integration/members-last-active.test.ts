import { randomUUID } from 'node:crypto'
import { apiKeys, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertSession, insertWorkspace, registerTestApiKey } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
}

type MemberRow = { actorId: string; lastActiveAt?: string | null }

async function addMember(workspaceId: string, type: 'agent' | 'human', role = 'member') {
	const actor = await insertActor(db, { type, name: `${type} member` })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role })
	return actor
}

async function setKeyUsed(actorId: string, lastUsedAt: Date) {
	await db.update(apiKeys).set({ lastUsedAt }).where(eq(apiKeys.actorId, actorId))
}

describe('GET /api/workspaces/:id/members — lastActiveAt', () => {
	async function listAs(workspaceId: string) {
		const res = await createApp().request(jsonGet(`/api/workspaces/${workspaceId}/members`))
		expect(res.status).toBe(200)
		return new Map(((await res.json()) as MemberRow[]).map((m) => [m.actorId, m]))
	}

	it('gives an owner the newest key use for a person and the newest session for an agent', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const person = await addMember(ws.id, 'human')
		await registerTestApiKey(db, person.id, `ank_${randomUUID().replace(/-/g, '')}`, 'login')
		await db
			.update(apiKeys)
			.set({ lastUsedAt: new Date('2026-10-01T08:00:00.000Z') })
			.where(and(eq(apiKeys.actorId, person.id), eq(apiKeys.kind, 'primary')))
		await db
			.update(apiKeys)
			.set({ lastUsedAt: new Date('2026-11-02T09:30:00.000Z') })
			.where(and(eq(apiKeys.actorId, person.id), eq(apiKeys.kind, 'login')))

		const agent = await addMember(ws.id, 'agent')
		await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'completed',
			createdAt: new Date('2026-10-20T10:00:00.000Z'),
		})
		await insertSession(db, ws.id, agent.id, getTestActorId(), {
			status: 'completed',
			createdAt: new Date('2026-11-05T11:15:00.000Z'),
		})

		const byId = await listAs(ws.id)
		expect(byId.get(person.id)?.lastActiveAt).toBe('2026-11-02T09:30:00.000Z')
		expect(byId.get(agent.id)?.lastActiveAt).toBe('2026-11-05T11:15:00.000Z')
	})

	it('gives null to a person whose keys were never used and to an agent with no session', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const person = await addMember(ws.id, 'human')
		const agent = await addMember(ws.id, 'agent')

		const byId = await listAs(ws.id)
		expect(byId.get(person.id)).toHaveProperty('lastActiveAt', null)
		expect(byId.get(agent.id)).toHaveProperty('lastActiveAt', null)
	})

	it("counts only this workspace's sessions for an agent", async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const otherWs = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(ws.id, 'agent')
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: otherWs.id, actorId: agent.id, role: 'member' })
		await insertSession(db, otherWs.id, agent.id, getTestActorId(), {
			status: 'completed',
			createdAt: new Date('2026-11-06T12:00:00.000Z'),
		})

		const byId = await listAs(ws.id)
		expect(byId.get(agent.id)).toHaveProperty('lastActiveAt', null)
	})

	it('leaves lastActiveAt out for a plain member and for a viewer', async () => {
		for (const role of ['member', 'viewer']) {
			const ws = await insertWorkspace(db, getTestActorId())
			const person = await addMember(ws.id, 'human')
			await setKeyUsed(person.id, new Date('2026-11-02T09:30:00.000Z'))
			await db
				.update(workspaceMembers)
				.set({ role })
				.where(
					and(
						eq(workspaceMembers.workspaceId, ws.id),
						eq(workspaceMembers.actorId, getTestActorId()),
					),
				)

			const byId = await listAs(ws.id)
			expect(byId.size).toBeGreaterThan(1)
			for (const row of byId.values()) expect(row).not.toHaveProperty('lastActiveAt')
		}
	})
})
