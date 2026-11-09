import type { MessageReaction } from '@/lib/api'
import { QUICK_REACTIONS, hasReacted, reactionLabel, toggleReaction } from '@/lib/message-reactions'
import { describe, expect, it } from 'vitest'

const me = { id: 'me', name: 'Me' }

function reaction(overrides: Partial<MessageReaction> = {}): MessageReaction {
	return {
		emoji: '👍',
		count: 1,
		reactedByMe: false,
		actors: [{ actorId: 'magnus', actorName: 'Magnus' }],
		...overrides,
	}
}

describe('QUICK_REACTIONS', () => {
	it('offers the same five emoji, in the same order, as the iOS message menu', () => {
		expect([...QUICK_REACTIONS]).toEqual(['👍', '❤️', '😂', '✅', '👀'])
	})
})

describe('hasReacted', () => {
	it('is true only for an emoji the caller used', () => {
		const list = [reaction({ reactedByMe: true }), reaction({ emoji: '❤️' })]
		expect(hasReacted(list, '👍')).toBe(true)
		expect(hasReacted(list, '❤️')).toBe(false)
		expect(hasReacted(list, '👀')).toBe(false)
		expect(hasReacted(undefined, '👍')).toBe(false)
	})
})

describe('toggleReaction', () => {
	it('adds a new emoji last, with the caller as its only reactor', () => {
		const out = toggleReaction([reaction()], '❤️', me)
		expect(out.map((r) => r.emoji)).toEqual(['👍', '❤️'])
		expect(out[1]).toMatchObject({ count: 1, reactedByMe: true })
		expect(out[1]?.actors).toEqual([{ actorId: 'me', actorName: 'Me' }])
	})

	it('starts a list when the message has none', () => {
		expect(toggleReaction(undefined, '👍', me)).toHaveLength(1)
	})

	it('joins an emoji someone else already used', () => {
		const out = toggleReaction([reaction()], '👍', me)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ count: 2, reactedByMe: true })
		expect(out[0]?.actors.map((a) => a.actorId)).toEqual(['magnus', 'me'])
	})

	it('takes the caller back out and keeps the others', () => {
		const start = [
			reaction({
				count: 2,
				reactedByMe: true,
				actors: [
					{ actorId: 'magnus', actorName: 'Magnus' },
					{ actorId: 'me', actorName: 'Me' },
				],
			}),
		]
		const out = toggleReaction(start, '👍', me)
		expect(out[0]).toMatchObject({ count: 1, reactedByMe: false })
		expect(out[0]?.actors.map((a) => a.actorId)).toEqual(['magnus'])
	})

	it('removes an emoji nobody uses any more', () => {
		const start = [reaction({ reactedByMe: true, actors: [{ actorId: 'me', actorName: 'Me' }] })]
		expect(toggleReaction(start, '👍', me)).toEqual([])
	})

	it('does not change the list it was given', () => {
		const start = [reaction()]
		toggleReaction(start, '👍', me)
		expect(start[0]).toMatchObject({ count: 1, reactedByMe: false })
	})
})

describe('reactionLabel', () => {
	it('puts "You" first and names up to three people', () => {
		const label = reactionLabel(
			reaction({
				count: 2,
				reactedByMe: true,
				actors: [
					{ actorId: 'magnus', actorName: 'Magnus' },
					{ actorId: 'me', actorName: 'Me' },
				],
			}),
			'me',
		)
		expect(label).toBe('You and Magnus reacted with 👍')
	})

	it('counts the rest past three', () => {
		const actors = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ actorId: id, actorName: id }))
		expect(reactionLabel(reaction({ count: 5, actors }), 'me')).toBe(
			'a, b, c and 2 others reacted with 👍',
		)
	})

	it('names a single reactor', () => {
		expect(reactionLabel(reaction(), 'me')).toBe('Magnus reacted with 👍')
	})
})
