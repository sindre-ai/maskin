/**
 * Finished runs grouped by flow in the summary facts, against real Postgres. The flow rule is the
 * one the billing usage breakdown uses: the flow that lists the run's trigger, else the flow its
 * item sits in, lowest id wins. A run that ties to no flow stays in the plain list.
 */
import { describe, expect, it } from 'vitest'
import { buildBriefingText, loadBriefingFacts } from '../../services/briefing-push-scheduler'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const NOW = new Date('2026-03-10T08:10:00Z')

async function setup() {
	const person = await insertActor(db, { type: 'human' })
	const personId = person.id as string
	const ws = await insertWorkspace(db, personId)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })

	const finish = async (
		hoursAgo: number,
		overrides: { triggerId?: string; itemId?: string } = {},
	) =>
		insertSession(db, workspaceId, agent.id as string, personId, {
			status: 'completed',
			interactive: false,
			triggerId: overrides.triggerId,
			initiatedFromObjectId: overrides.itemId,
			completedAt: new Date(NOW.getTime() - hoursAgo * 3600_000),
		})
	const item = (title: string) => insertObject(db, workspaceId, personId, { type: 'task', title })
	const flow = (title: string, metadata?: Record<string, unknown>) =>
		insertObject(db, workspaceId, personId, { type: 'loop', status: 'active', title, metadata })
	const putInFlow = (flowId: string, itemId: string) =>
		insertRelationship(db, personId, {
			sourceType: 'object',
			sourceId: flowId,
			targetType: 'object',
			targetId: itemId,
			type: 'in_loop',
		})
	const facts = async () => {
		const all = await loadBriefingFacts(db, personId, [], NOW)
		return all.find((f) => f.workspaceId === workspaceId)
	}
	return { personId, agent, workspaceId, finish, item, flow, putInFlow, facts }
}

describe('summary facts: finished runs by flow (Integration)', () => {
	it('groups runs by the flow that lists their trigger', async () => {
		const t = await setup()
		const trigger = await insertTrigger(db, t.workspaceId, t.personId, t.agent.id as string)
		await t.flow('Weekly research', { trigger_ids: [trigger.id] })
		const older = await t.item('Market scan')
		const newest = await t.item('Competitor update')
		await t.finish(5, { triggerId: trigger.id, itemId: older?.id })
		await t.finish(1, { triggerId: trigger.id, itemId: newest?.id })

		const facts = await t.facts()

		expect(facts?.finishedFlows).toEqual([
			{ flowName: 'Weekly research', runs: 2, latestTitle: 'Competitor update' },
		])
		expect(facts?.finishedRuns).toEqual([])
		expect(facts?.finished).toBe(2)
	})

	it('groups runs by the in_loop link of the item they worked on', async () => {
		const t = await setup()
		const support = await t.flow('Support')
		const a = await t.item('Ticket A')
		const b = await t.item('Ticket B')
		await t.putInFlow(support?.id as string, a?.id as string)
		await t.putInFlow(support?.id as string, b?.id as string)
		await t.finish(4, { itemId: a?.id })
		await t.finish(2, { itemId: b?.id })

		const facts = await t.facts()

		expect(facts?.finishedFlows).toEqual([
			{ flowName: 'Support', runs: 2, latestTitle: 'Ticket B' },
		])
	})

	it('counts a run once when its item sits in two flows: the lowest id wins', async () => {
		const t = await setup()
		const first = await t.flow('Flow one')
		const second = await t.flow('Flow two')
		const lowest = [first, second].sort((a, b) =>
			(a?.id as string).localeCompare(b?.id as string),
		)[0]
		const item = await t.item('Shared item')
		await t.putInFlow(first?.id as string, item?.id as string)
		await t.putInFlow(second?.id as string, item?.id as string)
		await t.finish(1, { itemId: item?.id })

		const facts = await t.facts()

		expect(facts?.finishedFlows).toEqual([
			{ flowName: lowest?.title, runs: 1, latestTitle: 'Shared item' },
		])
		expect(facts?.finished).toBe(1)
	})

	it('keeps a run that ties to no flow in the plain list', async () => {
		const t = await setup()
		const flow = await t.flow('Support')
		const tied = await t.item('Ticket')
		const loose = await t.item('One-off note')
		await t.putInFlow(flow?.id as string, tied?.id as string)
		await t.finish(3, { itemId: tied?.id })
		await t.finish(1, { itemId: loose?.id })
		await t.finish(2)

		const facts = await t.facts()

		expect(facts?.finishedFlows).toEqual([{ flowName: 'Support', runs: 1, latestTitle: 'Ticket' }])
		expect(facts?.finishedRuns?.map((r) => r.objectTitle)).toEqual(['One-off note', null])
		// The total is every finished run, tied or not, so the mail and the push say the same number.
		expect(facts?.finished).toBe(3)
	})

	it('leaves the push title and body as they were', async () => {
		const t = await setup()
		const flow = await t.flow('Support')
		const item = await t.item('Ticket')
		await t.putInFlow(flow?.id as string, item?.id as string)
		await t.finish(1, { itemId: item?.id })
		await t.finish(2)

		const facts = await t.facts()
		const text = buildBriefingText(facts ? [facts] : [])

		expect(text?.title).toBe('2 agent runs finished')
		expect(text?.finished).toBe(2)
	})
})
