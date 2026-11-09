import type { MessageReaction } from '@/lib/api'
import { QUICK_REACTIONS, hasReacted, reactionLabel, setReacted } from '@/lib/message-reactions'
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

const mine = (): MessageReaction =>
	reaction({
		count: 2,
		reactedByMe: true,
		actors: [
			{ actorId: 'magnus', actorName: 'Magnus' },
			{ actorId: 'me', actorName: 'Me' },
		],
	})

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

describe('setReacted', () => {
	it('adds a new emoji last, with the caller as its only reactor', () => {
		const out = setReacted([reaction()], '❤️', me, true)
		expect(out.map((r) => r.emoji)).toEqual(['👍', '❤️'])
		expect(out[1]).toMatchObject({ count: 1, reactedByMe: true })
		expect(out[1]?.actors).toEqual([{ actorId: 'me', actorName: 'Me' }])
	})

	it('starts a list when the message has none', () => {
		expect(setReacted(undefined, '👍', me, true)).toHaveLength(1)
	})

	it('joins an emoji someone else already used', () => {
		const out = setReacted([reaction()], '👍', me, true)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ count: 2, reactedByMe: true })
		expect(out[0]?.actors.map((a) => a.actorId)).toEqual(['magnus', 'me'])
	})

	it('takes the caller back out and keeps the others', () => {
		const out = setReacted([mine()], '👍', me, false)
		expect(out[0]).toMatchObject({ count: 1, reactedByMe: false })
		expect(out[0]?.actors.map((a) => a.actorId)).toEqual(['magnus'])
	})

	it('removes an emoji nobody uses any more', () => {
		const only = reaction({ reactedByMe: true, actors: [{ actorId: 'me', actorName: 'Me' }] })
		expect(setReacted([only], '👍', me, false)).toEqual([])
	})

	it('is a no-op when the wanted state already holds, so applying it twice changes nothing', () => {
		const once = setReacted([reaction()], '👍', me, true)
		expect(setReacted(once, '👍', me, true)).toBe(once)
		const list = [reaction()]
		expect(setReacted(list, '👍', me, false)).toBe(list)
		expect(setReacted(list, '❤️', me, false)).toBe(list)
	})

	it('does not change the list it was given', () => {
		const start = [reaction()]
		setReacted(start, '👍', me, true)
		expect(start[0]).toMatchObject({ count: 1, reactedByMe: false })
	})
})

describe('reactionLabel', () => {
	it('puts "You" first and names up to three people', () => {
		expect(reactionLabel(mine(), 'me')).toBe('You and Magnus reacted with 👍')
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

	it('decides who is "You" by id, never by a display name', () => {
		// Another person who is literally called "You" stays named, and sorts after the real "You".
		const label = reactionLabel(
			reaction({
				count: 2,
				reactedByMe: true,
				actors: [
					{ actorId: 'someone', actorName: 'You' },
					{ actorId: 'me', actorName: 'Me' },
				],
			}),
			'me',
		)
		expect(label).toBe('You and You reacted with 👍')
		const other = reactionLabel(
			reaction({ actors: [{ actorId: 'someone', actorName: 'You' }] }),
			'me',
		)
		expect(other).toBe('You reacted with 👍')
	})

	it('shows nobody as "You" when the caller is unknown', () => {
		expect(reactionLabel(mine(), undefined)).toBe('Magnus and Me reacted with 👍')
	})
})
