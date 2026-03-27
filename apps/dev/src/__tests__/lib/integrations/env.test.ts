import { afterEach, describe, expect, it } from 'vitest'
import { getEnvOrThrow } from '../../../lib/integrations/env'

describe('getEnvOrThrow', () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, 'TEST_ENV_VAR')
	})

	it('returns value when env var is set', () => {
		process.env.TEST_ENV_VAR = 'hello'
		expect(getEnvOrThrow('TEST_ENV_VAR')).toBe('hello')
	})

	it('throws when env var is not set', () => {
		expect(() => getEnvOrThrow('TEST_ENV_VAR')).toThrow(
			'TEST_ENV_VAR environment variable is required',
		)
	})

	it('throws when env var is empty string', () => {
		process.env.TEST_ENV_VAR = ''
		expect(() => getEnvOrThrow('TEST_ENV_VAR')).toThrow(
			'TEST_ENV_VAR environment variable is required',
		)
	})
})
