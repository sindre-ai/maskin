import { describe, expect, it } from 'vitest'
import { updateActorSchema } from '../schemas/actors'
import {
	STARTER_PROMPT_MAX_COUNT,
	STARTER_PROMPT_MAX_LENGTH,
	normalizeStarterPrompts,
	starterPromptListSchema,
} from '../schemas/starter-prompts'

describe('starterPromptListSchema', () => {
	it('accepts up to four prompts of up to 60 characters and trims each', () => {
		const full = ['a', 'b', 'c', 'd'].map((c) => c.repeat(STARTER_PROMPT_MAX_LENGTH))
		expect(starterPromptListSchema.parse(full)).toEqual(full)
		expect(starterPromptListSchema.parse(['  What needs me today?  '])).toEqual([
			'What needs me today?',
		])
	})

	it('accepts an empty list, which clears the starters', () => {
		expect(starterPromptListSchema.parse([])).toEqual([])
	})

	it('refuses a fifth prompt', () => {
		const five = Array.from({ length: STARTER_PROMPT_MAX_COUNT + 1 }, (_, i) => `p${i}`)
		expect(starterPromptListSchema.safeParse(five).success).toBe(false)
	})

	it('refuses a prompt over 60 characters', () => {
		expect(
			starterPromptListSchema.safeParse(['x'.repeat(STARTER_PROMPT_MAX_LENGTH + 1)]).success,
		).toBe(false)
	})

	it('refuses an empty or blank prompt', () => {
		expect(starterPromptListSchema.safeParse(['']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['   ']).success).toBe(false)
	})

	it('refuses a line break or other control character, so what is printed is what is sent', () => {
		expect(starterPromptListSchema.safeParse(['one\ntwo']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['tab\there']).success).toBe(false)
	})
})

describe('updateActorSchema', () => {
	it('takes starter_prompts as an optional field', () => {
		expect(updateActorSchema.parse({}).starter_prompts).toBeUndefined()
		expect(updateActorSchema.parse({ starter_prompts: ['Hi'] }).starter_prompts).toEqual(['Hi'])
	})
})

describe('normalizeStarterPrompts', () => {
	it('keeps plain strings, trimmed, de-duplicated case-insensitively with the first spelling', () => {
		expect(normalizeStarterPrompts(['  Hello  ', 'hello', 'World'])).toEqual(['Hello', 'World'])
	})

	it('drops anything that is not a sendable string', () => {
		expect(
			normalizeStarterPrompts(['ok', 7, null, { a: 1 }, '', '   ', 'two\nlines', 'x'.repeat(61)]),
		).toEqual(['ok'])
	})

	it('caps the list at four', () => {
		expect(normalizeStarterPrompts(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd'])
	})

	it('reads a non-list as none', () => {
		expect(normalizeStarterPrompts(undefined)).toEqual([])
		expect(normalizeStarterPrompts('not a list')).toEqual([])
		expect(normalizeStarterPrompts({ 0: 'a' })).toEqual([])
	})
})
