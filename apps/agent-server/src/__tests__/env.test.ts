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

	it('defaults WARM_POOL_REFRESH_MINUTES to 0 and leaves WARM_POOL_IMAGE unset', () => {
		const env = parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32) })
		expect(env.WARM_POOL_REFRESH_MINUTES).toBe(0)
		expect(env.WARM_POOL_IMAGE).toBeUndefined()
		expect(env.BROWSER_SIDECAR_IMAGE).toBe('browser-sidecar:latest')
	})

	it('parses a positive WARM_POOL_REFRESH_MINUTES alongside an image', () => {
		const env = parseEnv({
			AGENT_SERVER_SECRET: 'a'.repeat(32),
			WARM_POOL_REFRESH_MINUTES: '30',
			WARM_POOL_IMAGE: 'maskin/agent-base:latest',
			BROWSER_SIDECAR_IMAGE: 'maskin/browser-sidecar:latest',
		})
		expect(env.WARM_POOL_REFRESH_MINUTES).toBe(30)
		expect(env.WARM_POOL_IMAGE).toBe('maskin/agent-base:latest')
		expect(env.BROWSER_SIDECAR_IMAGE).toBe('maskin/browser-sidecar:latest')
	})

	it('rejects WARM_POOL_REFRESH_MINUTES outside 0..1440 or non-integer', () => {
		const secret = 'a'.repeat(32)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, WARM_POOL_REFRESH_MINUTES: '-1' }),
		).toThrow(/Invalid WARM_POOL_REFRESH_MINUTES/)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, WARM_POOL_REFRESH_MINUTES: '1441' }),
		).toThrow(/Invalid WARM_POOL_REFRESH_MINUTES/)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, WARM_POOL_REFRESH_MINUTES: '1.5' }),
		).toThrow(/Invalid WARM_POOL_REFRESH_MINUTES/)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, WARM_POOL_REFRESH_MINUTES: 'abc' }),
		).toThrow(/Invalid WARM_POOL_REFRESH_MINUTES/)
	})

	it('defaults SESSION_MAX_DURATION to 8h and accepts msb duration syntax / disable', () => {
		const secret = 'a'.repeat(32)
		expect(parseEnv({ AGENT_SERVER_SECRET: secret }).SESSION_MAX_DURATION).toBe('8h')
		expect(
			parseEnv({ AGENT_SERVER_SECRET: secret, SESSION_MAX_DURATION: '30m' }).SESSION_MAX_DURATION,
		).toBe('30m')
		expect(
			parseEnv({ AGENT_SERVER_SECRET: secret, SESSION_MAX_DURATION: '0' }).SESSION_MAX_DURATION,
		).toBe('0')
		expect(
			parseEnv({ AGENT_SERVER_SECRET: secret, SESSION_MAX_DURATION: '' }).SESSION_MAX_DURATION,
		).toBe('')
	})

	it('rejects a malformed SESSION_MAX_DURATION', () => {
		const secret = 'a'.repeat(32)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, SESSION_MAX_DURATION: '8 hours' }),
		).toThrow(/SESSION_MAX_DURATION/)
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: secret, SESSION_MAX_DURATION: 'forever' }),
		).toThrow(/SESSION_MAX_DURATION/)
	})

	it('leaves AGENT_SERVER_ID unset by default', () => {
		const env = parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32) })
		expect(env.AGENT_SERVER_ID).toBeUndefined()
	})

	it('accepts a valid AGENT_SERVER_ID uuid', () => {
		const env = parseEnv({
			AGENT_SERVER_SECRET: 'a'.repeat(32),
			AGENT_SERVER_ID: '123e4567-e89b-12d3-a456-426614174000',
		})
		expect(env.AGENT_SERVER_ID).toBe('123e4567-e89b-12d3-a456-426614174000')
	})

	it('rejects a non-uuid AGENT_SERVER_ID', () => {
		expect(() =>
			parseEnv({ AGENT_SERVER_SECRET: 'a'.repeat(32), AGENT_SERVER_ID: 'not-a-uuid' }),
		).toThrow()
	})
})
