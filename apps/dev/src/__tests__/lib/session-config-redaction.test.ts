import { describe, expect, it } from 'vitest'
import { MASKED_VALUE } from '../../lib/actor-tools-redaction'
import { redactSessionConfig } from '../../lib/session-config-redaction'

// Obviously fake values only.
const FAKE_ENV_VALUE = 'not-a-real-env-value'
const FAKE_MCP_ENV_VALUE = 'not-a-real-mcp-env-value'
const FAKE_HEADER_VALUE = 'Bearer not-a-real-header-value'

function buildConfig() {
	return {
		runtime: 'claude-code',
		timeout_seconds: 600,
		interactive: false,
		env_vars: { FAKE_TOKEN: FAKE_ENV_VALUE, REGION: 'eu' },
		mcps: [
			{
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp-server'],
				env: { FAKE_API_KEY: FAKE_MCP_ENV_VALUE },
			},
			{
				type: 'http',
				url: 'https://mcp.example.test/mcp',
				headers: { Authorization: FAKE_HEADER_VALUE },
			},
		],
		mention: { object_id: 'obj-1' },
	}
}

describe('redactSessionConfig', () => {
	it('masks every env_vars value and keeps the keys', () => {
		const redacted = redactSessionConfig(buildConfig()) as ReturnType<typeof buildConfig>

		expect(redacted.env_vars).toEqual({ FAKE_TOKEN: MASKED_VALUE, REGION: MASKED_VALUE })
	})

	it('masks mcps env and headers values and keeps keys, urls, commands and args', () => {
		const redacted = redactSessionConfig(buildConfig()) as ReturnType<typeof buildConfig>

		expect(redacted.mcps[0]).toEqual({
			type: 'stdio',
			command: 'npx',
			args: ['-y', 'fake-mcp-server'],
			env: { FAKE_API_KEY: MASKED_VALUE },
		})
		expect(redacted.mcps[1]).toEqual({
			type: 'http',
			url: 'https://mcp.example.test/mcp',
			headers: { Authorization: MASKED_VALUE },
		})
	})

	it('leaves the non-secret config fields intact', () => {
		const redacted = redactSessionConfig(buildConfig()) as ReturnType<typeof buildConfig>

		expect(redacted.runtime).toBe('claude-code')
		expect(redacted.timeout_seconds).toBe(600)
		expect(redacted.interactive).toBe(false)
		expect(redacted.mention).toEqual({ object_id: 'obj-1' })
	})

	it('leaves no fake value anywhere in the output', () => {
		const text = JSON.stringify(redactSessionConfig(buildConfig()))

		expect(text).not.toContain('not-a-real')
	})

	it('does not add env_vars or mcps to a config that has none', () => {
		expect(redactSessionConfig({ runtime: 'claude-code' })).toEqual({ runtime: 'claude-code' })
		expect(redactSessionConfig({})).toEqual({})
	})

	it('keeps an mcps entry without env or headers as it is', () => {
		const config = { mcps: [{ type: 'stdio', command: 'npx', args: [] }] }

		expect(redactSessionConfig(config)).toEqual(config)
	})

	it('passes null, undefined and non-object configs through', () => {
		expect(redactSessionConfig(null)).toBeNull()
		expect(redactSessionConfig(undefined)).toBeUndefined()
		expect(redactSessionConfig('text')).toBe('text')
	})

	it('does not mutate its input', () => {
		const input = buildConfig()

		redactSessionConfig(input)

		expect(input).toEqual(buildConfig())
	})
})
