import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readResendEnv } from '../env'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
	process.env.RESEND_API_KEY = 're_key'
	process.env.EMAIL_FROM = 'Maskin <hello@mail.maskin.ai>'
})

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
})

describe('readResendEnv', () => {
	it('returns both values when set', () => {
		expect(readResendEnv()).toEqual({
			apiKey: 're_key',
			from: 'Maskin <hello@mail.maskin.ai>',
		})
	})

	it('throws when RESEND_API_KEY is missing', () => {
		Reflect.deleteProperty(process.env, 'RESEND_API_KEY')
		expect(() => readResendEnv()).toThrow('RESEND_API_KEY environment variable is required')
	})

	it('throws when EMAIL_FROM is missing', () => {
		Reflect.deleteProperty(process.env, 'EMAIL_FROM')
		expect(() => readResendEnv()).toThrow('EMAIL_FROM environment variable is required')
	})
})
