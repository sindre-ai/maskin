import { dropPlainTail, parseIntroView } from '@/lib/agent-intro'
import { describe, expect, it } from 'vitest'

const STEPS = [
	{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' as const },
	{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' as const },
]

describe('parseIntroView', () => {
	it('reads steps, tools and the tail count from a well-formed intro', () => {
		expect(
			parseIntroView({
				suggested_steps: STEPS,
				needed_tools: [{ provider: 'gmail' }],
				plain_tail: 2,
			}),
		).toEqual({ steps: STEPS, tools: [{ provider: 'gmail' }], plainTail: 2 })
	})

	it('is null for a message that carries none of the intro keys', () => {
		expect(parseIntroView(null)).toBeNull()
		expect(parseIntroView({})).toBeNull()
		expect(parseIntroView({ mentions: [] })).toBeNull()
	})

	it('leaves tools null when only steps were written', () => {
		expect(parseIntroView({ suggested_steps: STEPS, plain_tail: 1 })?.tools).toBeNull()
	})

	it('is null when the steps fail to parse, so the plain body shows in full', () => {
		const bad = [{ label: 'Read my inbox', prompt: 'Delete my inbox', action: 'send' }]
		expect(
			parseIntroView({
				suggested_steps: bad as never,
				needed_tools: [{ provider: 'gmail' }],
				plain_tail: 2,
			}),
		).toBeNull()
	})

	it('is null when the tools fail to parse', () => {
		expect(
			parseIntroView({ suggested_steps: STEPS, needed_tools: [{ provider: '' }], plain_tail: 2 }),
		).toBeNull()
	})

	it('is null when the tail count is missing or not a whole number', () => {
		expect(parseIntroView({ suggested_steps: STEPS })).toBeNull()
		expect(parseIntroView({ suggested_steps: STEPS, plain_tail: 1.5 })).toBeNull()
		expect(parseIntroView({ suggested_steps: STEPS, plain_tail: -1 })).toBeNull()
	})
})

describe('dropPlainTail', () => {
	const body = 'Hey Sam, I am Scout.\n\nPromise.\n\nStart with one.\n\n1. A\n2. B\n\nReply here.'

	it('drops the last paragraphs, the list being one paragraph', () => {
		expect(dropPlainTail(body, 2)).toBe('Hey Sam, I am Scout.\n\nPromise.\n\nStart with one.')
	})

	it('drops nothing for a count of zero', () => {
		expect(dropPlainTail(body, 0)).toBe(body)
	})

	it('shows the whole body when the count would leave nothing', () => {
		expect(dropPlainTail(body, 5)).toBe(body)
		expect(dropPlainTail(body, 9)).toBe(body)
	})
})
