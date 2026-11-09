import { agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { buildWorkspaceSkill, insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspaceSkillsRoutes })
}

async function addAgent(workspaceId: string, name: string) {
	const agent = await insertActor(db, { type: 'agent', name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

async function addSkill(workspaceId: string, name: string, attachTo: string[]) {
	const [skill] = await db
		.insert(workspaceSkills)
		.values(buildWorkspaceSkill({ workspaceId, name, createdBy: getTestActorId() }))
		.returning()
	for (const actorId of attachTo) {
		await db.insert(agentSkills).values({ actorId, workspaceSkillId: skill.id })
	}
	return skill
}

describe('GET /api/workspaces/:id/skills — agentIds', () => {
	it('lists the agents on each skill in one call, and an empty list for a skill nobody has', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const zed = await addAgent(ws.id, 'Zed')
		const ada = await addAgent(ws.id, 'Ada')
		const shared = await addSkill(ws.id, 'shared-skill', [zed.id, ada.id])
		const solo = await addSkill(ws.id, 'solo-skill', [ada.id])
		const unused = await addSkill(ws.id, 'unused-skill', [])

		const res = await createApp().request(jsonGet(`/api/workspaces/${ws.id}/skills`))

		expect(res.status).toBe(200)
		const byId = new Map(
			((await res.json()) as Array<{ id: string; agentIds: string[] }>).map((s) => [s.id, s]),
		)
		expect(byId.get(shared.id)?.agentIds).toEqual([ada.id, zed.id])
		expect(byId.get(solo.id)?.agentIds).toEqual([ada.id])
		expect(byId.get(unused.id)?.agentIds).toEqual([])
	})

	it("never shows another workspace's agents, or an agent that left this workspace", async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const otherWs = await insertWorkspace(db, getTestActorId())
		const stayer = await addAgent(ws.id, 'Stayer')
		const stranger = await addAgent(otherWs.id, 'Stranger')
		const skill = await addSkill(ws.id, 'guarded-skill', [stayer.id, stranger.id])

		const res = await createApp().request(jsonGet(`/api/workspaces/${ws.id}/skills`))

		const rows = (await res.json()) as Array<{ id: string; agentIds: string[] }>
		expect(rows.find((s) => s.id === skill.id)?.agentIds).toEqual([stayer.id])
	})
})
