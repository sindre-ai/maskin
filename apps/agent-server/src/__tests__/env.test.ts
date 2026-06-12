import { describe, expect, it } from 'vitest'
import { parseEnv } from '../lib/env'

describe('parseEnv', () => {
	it('parses a complete env', () => {
		const env = parseEnv({
			PORT: '3001',
			AGENT_SERVER_SECRET: 'a'.repeat(32),
			MSB_BIN: '/usr/local/bin/msb',
		})
		expect(env.PORT).toBe(3001)
		expect(env.MSB_BIN).toBe('/usr/local/bin/msb')
	})

	it('defaults PORT to 3001 and MSB_BIN to the install path', () => {
		const env = parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32) })
		expect(env.PORT).toBe(3001)
		expect(env.MSB_BIN).toBe('/root/.microsandbox/bin/msb')
		expect(env.AGENT_SESSION_ROOT).toBe('/agent/sessions')
	})

	it('rejects PORT values outside the valid range', () => {
		expect(() => parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32), PORT: 'abc' })).toThrow(
			/Invalid PORT/,
		)
		expect(() => parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32), PORT: '0' })).toThrow(
			/Invalid PORT/,
		)
		expect(() => parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32), PORT: '70000' })).toThrow(
			/Invalid PORT/,
		)
	})

	it('rejects a missing or short AGENT_SERVER_SECRET', () => {
		expect(() => parseEnv({})).toThrow()
		expect(() => parseEnv({ AGENT_SERVER_SECRET: 'short' })).toThrow(/16 chars/)
	})
})
