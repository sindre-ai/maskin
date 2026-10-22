import { integrations, workspaceMembers } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import { describeAgentAccess } from '../../lib/integrations/agent-access-view'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	return { human, ws, agent }
}

const connect = (
	s: Awaited<ReturnType<typeof setup>>,
	provider: string,
	over: Partial<typeof integrations.$inferInsert> = {},
) =>
	db
		.insert(integrations)
		.values({
			workspaceId: s.ws.id,
			provider,
			status: 'active',
			credentials: 'x',
			createdBy: s.human,
			...over,
		})
		.returning()

describe('describeAgentAccess names (Integration)', () => {
	it('tells two GitHub accounts apart by their org', async () => {
		const s = await setup()
		await connect(s, 'github', { externalId: '1', config: { owner_login: 'sindre-ai' } })
		await connect(s, 'github', { externalId: '2', config: { owner_login: 'vaerksted-ai' } })

		const view = await describeAgentAccess(db, s.ws.id, s.agent.id)

		expect(view.integrations.map((i) => i.name).sort()).toEqual([
			'GitHub (sindre-ai)',
			'GitHub (vaerksted-ai)',
		])
	})

	it('keeps the plain name when a provider is connected only once', async () => {
		const s = await setup()
		await connect(s, 'github', { externalId: '1', config: { owner_login: 'sindre-ai' } })
		await connect(s, 'slack')

		const view = await describeAgentAccess(db, s.ws.id, s.agent.id)

		expect(view.integrations.map((i) => i.name).sort()).toEqual(['GitHub', 'Slack'])
	})

	it('names each LinkedIn account after the member who connected it', async () => {
		const s = await setup()
		const colleague = await insertActor(db, { type: 'human', name: 'Colleague' })
		await connect(s, 'linkedin-unipile', { externalId: 'a', actorId: s.human })
		await connect(s, 'linkedin-unipile', {
			externalId: 'b',
			actorId: colleague.id,
			createdBy: colleague.id,
		})

		const view = await describeAgentAccess(db, s.ws.id, s.agent.id)

		const names = view.integrations.map((i) => i.name)
		expect(names).toHaveLength(2)
		expect(names).toContain('LinkedIn (Colleague)')
		expect(names.every((n) => n.startsWith('LinkedIn ('))).toBe(true)
	})
})
