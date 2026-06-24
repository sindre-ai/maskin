import { describe, expect, it } from 'vitest'
import { createObjectSchema } from '../schemas/objects'
import {
	SIGNUP_CAPTURE_SOURCE,
	SIGNUP_CAPTURE_STATUS,
	SIGNUP_CAPTURE_TAGS,
	buildSignupCaptureKnowledge,
	signupCaptureInputSchema,
} from '../schemas/signup-capture'

describe('signupCaptureInputSchema', () => {
	it('accepts trimmed name, org, role', () => {
		const result = signupCaptureInputSchema.parse({
			name: '  Ada Lovelace  ',
			organization: 'Analytical Engine Co.',
			role: 'Founder',
		})
		expect(result).toEqual({
			name: 'Ada Lovelace',
			organization: 'Analytical Engine Co.',
			role: 'Founder',
		})
	})

	it('rejects empty name, org, or role', () => {
		expect(() =>
			signupCaptureInputSchema.parse({ name: '', organization: 'x', role: 'y' }),
		).toThrow()
		expect(() =>
			signupCaptureInputSchema.parse({ name: 'a', organization: '   ', role: 'y' }),
		).toThrow()
		expect(() =>
			signupCaptureInputSchema.parse({ name: 'a', organization: 'b', role: '' }),
		).toThrow()
	})

	it('rejects values over 200 chars', () => {
		expect(() =>
			signupCaptureInputSchema.parse({
				name: 'a'.repeat(201),
				organization: 'b',
				role: 'c',
			}),
		).toThrow()
	})
})

describe('buildSignupCaptureKnowledge', () => {
	const input = { name: 'Ada Lovelace', organization: 'Analytical Engine Co.', role: 'Founder' }

	it('returns a payload that satisfies createObjectSchema', () => {
		const payload = buildSignupCaptureKnowledge(input)
		expect(() => createObjectSchema.parse(payload)).not.toThrow()
	})

	it('produces the expected wire shape', () => {
		const payload = buildSignupCaptureKnowledge(input)
		expect(payload.type).toBe('knowledge')
		expect(payload.status).toBe(SIGNUP_CAPTURE_STATUS)
		expect(payload.title).toBe('Signup context — Ada Lovelace')
		expect(payload.content).toContain('**Name:** Ada Lovelace')
		expect(payload.content).toContain('**Organization:** Analytical Engine Co.')
		expect(payload.content).toContain('**Role:** Founder')

		const meta = payload.metadata as Record<string, unknown>
		expect(meta.source).toBe(SIGNUP_CAPTURE_SOURCE)
		expect(meta.name).toBe('Ada Lovelace')
		expect(meta.organization).toBe('Analytical Engine Co.')
		expect(meta.role).toBe('Founder')
		expect(meta.tags).toEqual([...SIGNUP_CAPTURE_TAGS])
		expect(meta.confidence).toBe('high')
		expect(meta.summary).toContain('Ada Lovelace')
		expect(typeof meta.last_validated_at).toBe('string')
		expect(() => new Date(meta.last_validated_at as string).toISOString()).not.toThrow()
	})

	it('trims input before writing', () => {
		const payload = buildSignupCaptureKnowledge({
			name: '  Ada  ',
			organization: '  Co  ',
			role: '  Eng  ',
		})
		const meta = payload.metadata as Record<string, unknown>
		expect(meta.name).toBe('Ada')
		expect(meta.organization).toBe('Co')
		expect(meta.role).toBe('Eng')
		expect(payload.title).toBe('Signup context — Ada')
	})

	it('throws on invalid input rather than producing an empty payload', () => {
		expect(() => buildSignupCaptureKnowledge({ name: '', organization: 'x', role: 'y' })).toThrow()
	})
})
