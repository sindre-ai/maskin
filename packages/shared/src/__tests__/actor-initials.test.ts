import { describe, expect, it } from 'vitest'
import { actorInitialsSchema, normalizeActorInitials } from '../schemas/actor-initials'

describe('actorInitialsSchema', () => {
	it('accepts 1 to 3 letters or digits, trimmed, and the empty string that clears', () => {
		expect(actorInitialsSchema.parse(' dev ')).toBe('dev')
		expect(actorInitialsSchema.parse('A')).toBe('A')
		expect(actorInitialsSchema.parse('Å1')).toBe('Å1')
		expect(actorInitialsSchema.parse('  ')).toBe('')
	})

	it('refuses four characters, spaces inside, and symbols', () => {
		for (const bad of ['ABCD', 'A B', 'A-B', '<b>', 'A.']) {
			expect(actorInitialsSchema.safeParse(bad).success).toBe(false)
		}
	})
})

describe('normalizeActorInitials', () => {
	it('upper-cases and trims', () => {
		expect(normalizeActorInitials(' dev ')).toBe('DEV')
		expect(normalizeActorInitials('co')).toBe('CO')
	})

	it('reads anything unusable as null', () => {
		for (const bad of [undefined, null, 5, {}, '', '   ', 'ABCD', 'A B', 'ßßß']) {
			expect(normalizeActorInitials(bad)).toBeNull()
		}
	})
})
