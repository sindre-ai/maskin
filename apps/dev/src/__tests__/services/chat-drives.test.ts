import { describe, expect, it } from 'vitest'
import { CHAT_DRIVES_MAX, buildChatDrivesBlock } from '../../services/chat-drives'
import { createTestContext } from '../setup'

const WS = '11111111-1111-1111-1111-111111111111'
const ACTOR = '22222222-2222-2222-2222-222222222222'
const CONVERSATION = '33333333-3333-3333-3333-333333333333'
const FRONTEND = 'https://maskin.io/'
const session = { workspaceId: WS, actorId: ACTOR, conversationId: CONVERSATION }

const objectUrl = (id: string) => `https://maskin.io/${WS}/objects/${id}`

function loop(id: string, title: string, metadata: unknown, status = 'supervised') {
	return { id, type: 'loop', title, status, metadata }
}

function task(id: string, title: string, status = 'in_progress') {
	return { id, type: 'task', title, status, metadata: null }
}

describe('buildChatDrivesBlock', () => {
	it('gives an agent that drives nothing no block', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[], []] // driven loops, driven open objects
		expect(await buildChatDrivesBlock(db, session, FRONTEND)).toBe('')
	})

	it('lists a driven loop with its targets and close condition, and says the agent owns the outcomes', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[
				loop('a1', 'Events', {
					targets: [
						{ label: 'Registrations', source: 'manual', actual: 1, target: 100 },
						{ label: 'Webinars held', source: 'manual', actual: 0, target: 4 },
					],
					close_condition: 'The webinar has run.',
				}),
			],
			[task('b1', 'Draft the invite')],
			[{ subjectType: null, subjectId: null }], // the chat is about nothing in particular
		]
		const block = await buildChatDrivesBlock(db, session, FRONTEND)
		expect(block).toContain('## What you drive')
		expect(block).toContain('You own these outcomes. The person in this chat supports you.')
		expect(block).toContain(
			`- [Events](${objectUrl('a1')}) (supervised). Targets: Registrations: 1 of 100; Webinars held: 0 of 4. Closes when: The webinar has run.`,
		)
		expect(block).toContain(`- [Draft the invite](${objectUrl('b1')}) (task, in_progress)`)
		expect(block).not.toContain('This chat is about')
	})

	it('leads with the loop the chat is about, even when the agent does not drive it', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[loop('a1', 'Events', null)],
			[],
			[{ subjectType: 'loop', subjectId: 'c1' }],
			[
				loop('c1', 'Webinar', {
					targets: [{ label: 'Seats', source: 'manual', actual: 3, target: 50 }],
				}),
			],
		]
		const block = await buildChatDrivesBlock(db, session, FRONTEND)
		expect(block).toContain(`This chat is about [Webinar](${objectUrl('c1')}) (loop, supervised).`)
		expect(block.indexOf('[Webinar]')).toBeLessThan(block.indexOf('[Events]'))
		expect(block).toContain('Seats: 3 of 50')
	})

	it('names the object the chat is about once, and not again in the open items', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[],
			[task('b1', 'Draft the invite'), task('b2', 'Book the room')],
			[{ subjectType: 'object', subjectId: 'b2' }],
		]
		const block = await buildChatDrivesBlock(db, session, FRONTEND)
		expect(block).toContain(
			`This chat is about [Book the room](${objectUrl('b2')}) (task, in_progress).`,
		)
		expect(block.match(/Book the room/g)).toHaveLength(1)
		expect(block).toContain('Draft the invite')
	})

	it('skips target rows that are malformed', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[
				loop('a1', 'Events', {
					targets: [
						{ label: 'Good', source: 'manual', actual: 1, target: 2 },
						{ label: 'No numbers', source: 'manual' },
						'nonsense',
					],
				}),
			],
			[],
			[{ subjectType: null, subjectId: null }],
		]
		const block = await buildChatDrivesBlock(db, session, FRONTEND)
		expect(block).toContain('Targets: Good: 1 of 2')
		expect(block).not.toContain('No numbers')
	})

	it('stays under the character cap by dropping whole lines from the end', async () => {
		const { db, mockResults } = createTestContext()
		const heavy = (n: number) =>
			loop(`a${n}`, `Loop ${n}`, {
				targets: Array.from({ length: 6 }, (_, i) => ({
					label: `${'x'.repeat(110)}${i}`,
					source: 'manual',
					actual: 1,
					target: 2,
				})),
				close_condition: 'y'.repeat(500),
			})
		mockResults.selectQueue = [
			[heavy(1), heavy(2), heavy(3)],
			Array.from({ length: 6 }, (_, i) => task(`b${i}`, `Task ${i}`)),
			[{ subjectType: null, subjectId: null }],
		]
		const block = await buildChatDrivesBlock(db, session, FRONTEND)
		expect(block.trim().length).toBeLessThanOrEqual(CHAT_DRIVES_MAX)
		expect(block).toContain('(more on the objects you drive)')
		expect(block).toContain('[Loop 1]')
	})
})
