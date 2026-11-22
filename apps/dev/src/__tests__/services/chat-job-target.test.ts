import { describe, expect, it } from 'vitest'
import {
	CHAT_JOB_TARGET_MAX,
	buildChatJobTargetBlock,
	renderJobTargetBlock,
} from '../../services/chat-job-target'
import { createTestContext } from '../setup'

const WS = '11111111-1111-1111-1111-111111111111'
const ACTOR = '22222222-2222-2222-2222-222222222222'
const CONVERSATION = '33333333-3333-3333-3333-333333333333'
const FRONTEND = 'https://maskin.io/'
const session = { workspaceId: WS, actorId: ACTOR, conversationId: CONVERSATION }

const objectUrl = (id: string) => `https://maskin.io/${WS}/objects/${id}`

const flow = (id: string, title: string, metadata: unknown = null) => ({ id, title, metadata })

describe('renderJobTargetBlock', () => {
	it('gives the rules, the lookup order and the setup request', () => {
		const block = renderJobTargetBlock({
			flows: [],
			companyTargets: [],
			workspaceId: WS,
			frontendUrl: FRONTEND,
		})
		expect(block).toContain('## Jobs you are handed')
		expect(block).toContain('a flow target below')
		expect(block).toContain('then a company target, then neither')
		expect(block).toContain('start the follow-up steps')
		expect(block).toContain('schedule_next_step')
		expect(block).toContain("Never send in a person's name, spend money or delete")
		expect(block).toContain('ask once for that setup')
		expect(block).toContain('A plain factual question gets none of this.')
		expect(block).toContain('No flow target found')
		expect(block).toContain('No company target found')
	})

	it('lists a flow target with its owner, deadline and the company target it serves', () => {
		const block = renderJobTargetBlock({
			flows: [
				{
					id: 'f1',
					title: 'Events',
					targets: [
						{
							id: 't1',
							label: 'Registrations',
							actual: 12,
							target: 50,
							ownerName: 'Event agent',
							deadline: '2027-01-31',
							status: 'open',
							servesTitle: '10 paying customers',
						},
					],
				},
			],
			companyTargets: [
				{
					id: 'c1',
					label: '10 paying customers',
					actual: 2,
					target: 10,
					ownerName: null,
					deadline: '2027-01-31',
					status: 'open',
				},
			],
			workspaceId: WS,
			frontendUrl: FRONTEND,
		})
		expect(block).toContain(`- [Events](${objectUrl('f1')})`)
		expect(block).toContain(
			`  - [Registrations](${objectUrl('t1')}): 12 of 50, owner Event agent, due 2027-01-31, serves 10 paying customers`,
		)
		expect(block).toContain(
			`- [10 paying customers](${objectUrl('c1')}): 2 of 10, no owner, due 2027-01-31`,
		)
	})

	it('stays under the character cap by dropping whole lines from the end', () => {
		const block = renderJobTargetBlock({
			flows: [
				{
					id: 'f1',
					title: 'Events',
					targets: Array.from({ length: 40 }, (_, i) => ({
						label: `Target ${i} ${'x'.repeat(60)}`,
						actual: 1,
						target: 2,
						ownerName: 'Someone',
						deadline: null,
						status: 'open',
					})),
				},
			],
			companyTargets: [],
			workspaceId: WS,
			frontendUrl: FRONTEND,
		})
		expect(block.trim().length).toBeLessThanOrEqual(CHAT_JOB_TARGET_MAX)
		expect(block).toContain('(more targets on the flows you drive)')
		expect(block).toContain('A plain factual question gets none of this.')
	})
})

describe('buildChatJobTargetBlock', () => {
	it('reads a driven flow target from its target object, with owner and parent', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ subjectId: null }], // the chat is about nothing in particular
			[
				flow('f1', 'Events', {
					targets: [{ label: 'Old row', source: 'manual', actual: 0, target: 9 }],
				}),
			], // driven flows
			[
				{
					loopId: 'f1',
					id: 't1',
					title: 'Registrations',
					status: 'open',
					driver: 'a1',
					metadata: { actual: 12, target: 50, deadline: '2027-01-31T00:00:00.000Z' },
				},
			], // target objects
			[{ childId: 't1', title: '10 paying customers' }], // parent company target
			[], // company targets
			[{ id: 'a1', name: 'Event agent' }], // owner names
		]
		const block = await buildChatJobTargetBlock(db, session, FRONTEND)
		expect(block).toContain(
			`[Registrations](${objectUrl('t1')}): 12 of 50, owner Event agent, due 2027-01-31, serves 10 paying customers`,
		)
		expect(block).not.toContain('Old row')
	})

	it('falls back to the old rows of a flow with no target objects', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ subjectId: null }],
			[
				flow('f1', 'Events', {
					targets: [{ label: 'Old row', source: 'manual', actual: 1, target: 9 }],
				}),
			],
			[], // no target objects
			[], // company targets
		]
		const block = await buildChatJobTargetBlock(db, session, FRONTEND)
		expect(block).toContain('Old row: 1 of 9, no owner')
	})

	it('leads with the flow an object belongs to, then adds the driven flows once', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ subjectId: 'task-1' }],
			[{ id: 'task-1', title: 'Create a webinar', metadata: null, type: 'task' }],
			[flow('f2', 'Sales')], // flows the task is a member of
			[flow('f1', 'Events'), flow('f2', 'Sales')], // driven flows, f2 repeated
			[], // target objects
			[], // company targets
		]
		const block = await buildChatJobTargetBlock(db, session, FRONTEND)
		expect(block.indexOf('[Sales]')).toBeLessThan(block.indexOf('[Events]'))
		expect(block.match(/\[Sales\]/g)).toHaveLength(1)
		expect(block).toContain(': no targets set')
	})

	it('lists company targets when the agent drives no flow', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ subjectId: null }],
			[], // driven flows
			[
				{
					id: 'c1',
					title: '10 paying customers',
					status: 'open',
					driver: null,
					metadata: { actual: 2, target: 10, deadline: '2027-01-31' },
				},
			],
		]
		const block = await buildChatJobTargetBlock(db, session, FRONTEND)
		expect(block).toContain('No flow target found')
		expect(block).toContain(
			`- [10 paying customers](${objectUrl('c1')}): 2 of 10, no owner, due 2027-01-31`,
		)
	})
})
