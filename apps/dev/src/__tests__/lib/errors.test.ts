import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createInvalidTypeError, formatZodError } from '../../lib/errors'

describe('formatZodError', () => {
	it('maps invalid_type issues with expected and received', () => {
		const schema = z.object({ name: z.string() })
		const result = schema.safeParse({ name: 123 })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('name')
		expect(details[0].expected).toBe('string')
		expect(details[0].received).toBe('number')
	})

	it('maps invalid_enum_value issues with formatted options', () => {
		const schema = z.object({ type: z.enum(['insight', 'bet', 'task']) })
		const result = schema.safeParse({ type: 'invalid' })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('type')
		expect(details[0].expected).toContain("'insight'")
		expect(details[0].expected).toContain("'bet'")
		expect(details[0].expected).toContain("'task'")
		expect(details[0].received).toBe('invalid')
	})

	it('maps invalid_string with uuid validation', () => {
		const schema = z.object({ id: z.string().uuid() })
		const result = schema.safeParse({ id: 'not-a-uuid' })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('id')
		expect(details[0].expected).toContain('UUID')
	})

	it('maps invalid_string with email validation', () => {
		const schema = z.object({ email: z.string().email() })
		const result = schema.safeParse({ email: 'not-email' })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('email')
		expect(details[0].expected).toContain('email')
	})

	it('maps too_small with minimum length', () => {
		const schema = z.object({ name: z.string().min(3) })
		const result = schema.safeParse({ name: 'ab' })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('name')
		expect(details[0].expected).toContain('minimum')
		expect(details[0].expected).toContain('3')
	})

	it('maps too_big with maximum length', () => {
		const schema = z.object({ name: z.string().max(5) })
		const result = schema.safeParse({ name: 'toolong' })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('name')
		expect(details[0].expected).toContain('maximum')
		expect(details[0].expected).toContain('5')
	})

	it('maps root-level error to _root field', () => {
		const schema = z.string()
		const result = schema.safeParse(123)
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('_root')
	})

	it('maps nested path to dot-joined field name', () => {
		const schema = z.object({ config: z.object({ schedule: z.string() }) })
		const result = schema.safeParse({ config: { schedule: 42 } })
		if (result.success) throw new Error('Expected failure')

		const details = formatZodError(result.error)
		expect(details).toHaveLength(1)
		expect(details[0].field).toBe('config.schedule')
	})
})

describe('createInvalidTypeError', () => {
	it('returns structured error with valid types listed', () => {
		const error = createInvalidTypeError('bug', 'type', ['insight', 'bet', 'task'])

		expect(error).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining("'bug'"),
					details: expect.arrayContaining([
						expect.objectContaining({
							field: 'type',
							received: "'bug'",
						}),
					]),
				}),
			}),
		)
	})

	it('returns special message when validTypes is empty', () => {
		const error = createInvalidTypeError('bet', 'type', [])

		expect(error.error.message).toContain('No object types available')
		expect(error.error.details?.[0].message).toContain('No extensions are enabled')
		expect(error.error.suggestion).toContain('Enable an extension')
	})
})
