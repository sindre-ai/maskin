import { describe, expect, it } from 'vitest'
import { updateActorSchema } from '../schemas/actors'
import {
	STARTER_PROMPT_MAX_COUNT,
	STARTER_PROMPT_MAX_LENGTH,
	normalizeStarterPrompts,
	starterPromptKey,
	starterPromptListSchema,
	withStarterPrompt,
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
		// C1 (U+0085 "next line") and the Unicode line and paragraph separators.
		expect(starterPromptListSchema.safeParse(['one\u0085two']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['one two']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['one two']).success).toBe(false)
	})

	it('refuses a repeat instead of quietly dropping it, ignoring capitals and padding', () => {
		expect(starterPromptListSchema.safeParse(['Hi', 'hi']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['Hi', '  HI  ']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['Hi', 'Hello', 'hi']).success).toBe(false)
		expect(starterPromptListSchema.safeParse(['Hi', 'Hello']).success).toBe(true)
	})

	it('treats a final sigma and an ordinary one as the same letter', () => {
		expect(starterPromptListSchema.safeParse(['ΑΣ', 'ας']).success).toBe(false)
	})

	it('names the repeated entry in the error', () => {
		const result = starterPromptListSchema.safeParse(['Hi', 'Hello', 'HI'])
		expect(result.success).toBe(false)
		if (!result.success) expect(result.error.issues[0]?.path).toEqual([2])
	})
})

describe('updateActorSchema', () => {
	it('takes starter_prompts as an optional field', () => {
		expect(updateActorSchema.parse({}).starter_prompts).toBeUndefined()
		expect(updateActorSchema.parse({ starter_prompts: ['Hi'] }).starter_prompts).toEqual(['Hi'])
	})
})

// These vectors are mirrored in apps/apple/Tests/MaskinCoreTests/Chats/StarterPromptsTests.swift.
// The Swift reader is a port of normalizeStarterPrompts: change a vector here, change it there.
describe('normalizeStarterPrompts (shared vectors with the Swift reader)', () => {
	it('keeps plain strings, trimmed, de-duplicated with the first spelling', () => {
		expect(normalizeStarterPrompts(['  Hello  ', 'hello', 'World'])).toEqual(['Hello', 'World'])
	})

	it('trims what JavaScript trims: U+FEFF, no-break space, line separators', () => {
		expect(normalizeStarterPrompts(['﻿Hi﻿'])).toEqual(['Hi'])
		expect(normalizeStarterPrompts([' Hi '])).toEqual(['Hi'])
		expect(normalizeStarterPrompts([' Hi '])).toEqual(['Hi'])
		expect(normalizeStarterPrompts(['　Hi　'])).toEqual(['Hi'])
	})

	it('does not trim U+0085, it is a control character and the entry is dropped', () => {
		expect(normalizeStarterPrompts(['\u0085Hi', 'Ok'])).toEqual(['Ok'])
	})

	it('drops anything that is not a sendable string', () => {
		expect(
			normalizeStarterPrompts(['ok', 7, null, { a: 1 }, '', '   ', 'two\nlines', 'x'.repeat(61)]),
		).toEqual(['ok'])
		expect(normalizeStarterPrompts(['one two', 'fine'])).toEqual(['fine'])
	})

	it('folds case and the final sigma the same way for a repeat', () => {
		expect(normalizeStarterPrompts(['ΑΣ', 'ας', 'Other'])).toEqual(['ΑΣ', 'Other'])
		expect(normalizeStarterPrompts(['İstanbul', 'i̇stanbul'])).toEqual(['İstanbul'])
		expect(normalizeStarterPrompts(['Straße', 'STRASSE'])).toEqual(['Straße', 'STRASSE'])
	})

	it('measures length in UTF-16 units, so an emoji counts as two', () => {
		expect(normalizeStarterPrompts(['😀'.repeat(30)])).toEqual(['😀'.repeat(30)])
		expect(normalizeStarterPrompts(['😀'.repeat(31)])).toEqual([])
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

describe('starterPromptKey', () => {
	it('lower-cases and folds the final sigma', () => {
		expect(starterPromptKey('ΑΣ')).toBe('ασ')
		expect(starterPromptKey('ας')).toBe('ασ')
		expect(starterPromptKey('Hello')).toBe('hello')
	})
})

describe('withStarterPrompt', () => {
	it('puts the prompt in an empty or blank box', () => {
		expect(withStarterPrompt('', 'What needs me today?')).toBe('What needs me today?')
		expect(withStarterPrompt('   ', 'What needs me today?')).toBe('What needs me today?')
	})

	it('keeps what the person typed and puts the prompt after it, one space between', () => {
		expect(withStarterPrompt('Quick one:', 'What needs me today?')).toBe(
			'Quick one: What needs me today?',
		)
		expect(withStarterPrompt('Quick one:   ', 'What needs me today?')).toBe(
			'Quick one: What needs me today?',
		)
	})
})
