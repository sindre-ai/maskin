import { describe, expect, it } from 'vitest'
import {
	MASKED_VALUE,
	hasSecretFields,
	maskActorTools,
	maskArgs,
	restoreMaskedToolValues,
} from '../../lib/actor-tools-redaction'

// Obviously fake values only.
const FAKE_ENV_VALUE = 'fake-env-value-not-a-secret'
const FAKE_HEADER_VALUE = 'Bearer fake-header-value-not-a-secret'

function buildTools() {
	return {
		mcpServers: {
			tracker: {
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp-server'],
				env: { FAKE_API_KEY: FAKE_ENV_VALUE, FAKE_REGION: 'eu' },
			},
			docs: {
				type: 'http',
				url: 'https://mcp.example.test/mcp',
				headers: { Authorization: FAKE_HEADER_VALUE },
			},
		},
	}
}

describe('maskActorTools', () => {
	it('masks every env and header value and keeps keys, commands, args and urls', () => {
		const masked = maskActorTools(buildTools()) as ReturnType<typeof buildTools>

		expect(masked.mcpServers.tracker.env).toEqual({
			FAKE_API_KEY: MASKED_VALUE,
			FAKE_REGION: MASKED_VALUE,
		})
		expect(masked.mcpServers.docs.headers).toEqual({ Authorization: MASKED_VALUE })
		expect(masked.mcpServers.tracker.command).toBe('npx')
		expect(masked.mcpServers.tracker.args).toEqual(['-y', 'fake-mcp-server'])
		expect(masked.mcpServers.docs.url).toBe('https://mcp.example.test/mcp')
	})

	it('leaves no literal value anywhere in the serialized output', () => {
		const serialized = JSON.stringify(maskActorTools(buildTools()))

		expect(serialized).not.toContain(FAKE_ENV_VALUE)
		expect(serialized).not.toContain(FAKE_HEADER_VALUE)
	})

	it('does not mutate the stored config', () => {
		const tools = buildTools()
		maskActorTools(tools)

		expect(tools.mcpServers.tracker.env.FAKE_API_KEY).toBe(FAKE_ENV_VALUE)
	})

	it('returns null, empty and secret-free configs unchanged', () => {
		const noSecrets = {
			mcpServers: { plain: { type: 'stdio', command: 'node', args: [], env: {} } },
		}

		expect(maskActorTools(null)).toBeNull()
		expect(maskActorTools({ mcpServers: {} })).toEqual({ mcpServers: {} })
		expect(maskActorTools(noSecrets)).toBe(noSecrets)
		expect(hasSecretFields(noSecrets)).toBe(false)
	})
})

describe('restoreMaskedToolValues', () => {
	it('puts the stored value back for a masked field and keeps edited ones', () => {
		const stored = buildTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildTools>
		incoming.mcpServers.tracker.env.FAKE_REGION = 'us'

		const { tools, unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual([])
		expect(tools).toEqual({
			mcpServers: {
				...stored.mcpServers,
				tracker: {
					...stored.mcpServers.tracker,
					env: { FAKE_API_KEY: FAKE_ENV_VALUE, FAKE_REGION: 'us' },
				},
			},
		})
	})

	it('restores when the stored row predates the type and args defaults', () => {
		const stored = {
			mcpServers: { tracker: { command: 'npx', env: { FAKE_API_KEY: FAKE_ENV_VALUE } } },
		}
		const incoming = {
			mcpServers: {
				tracker: { type: 'stdio', command: 'npx', args: [], env: { FAKE_API_KEY: MASKED_VALUE } },
			},
		}

		const { tools, unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual([])
		expect(JSON.stringify(tools)).toContain(FAKE_ENV_VALUE)
	})

	it('refuses to restore into a server whose url was changed', () => {
		const stored = buildTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildTools>
		incoming.mcpServers.docs.url = 'https://attacker.example.test/mcp'

		const { tools, unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual(['docs.headers.Authorization'])
		expect(JSON.stringify(tools)).not.toContain(FAKE_HEADER_VALUE)
	})

	it('refuses to restore into a server whose command or args were changed', () => {
		const stored = buildTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildTools>
		incoming.mcpServers.tracker.args = ['-y', 'other-package']

		const { unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual(['tracker.env.FAKE_API_KEY', 'tracker.env.FAKE_REGION'])
	})

	it('reports a masked key that has no stored counterpart', () => {
		const stored = buildTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildTools>
		;(incoming.mcpServers as Record<string, unknown>).renamed = incoming.mcpServers.docs

		const { unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual(['renamed.headers.Authorization'])
	})

	it('reports masked values when nothing is stored yet', () => {
		const incoming = maskActorTools(buildTools()) as ReturnType<typeof buildTools>

		expect(restoreMaskedToolValues(incoming, null).unresolved).toHaveLength(3)
	})
})

// A command-style server carrying a credential inside its args. Fake values only.
const FAKE_ARG_TOKEN = 'fake-arg-token-not-a-secret'

function buildArgsTools() {
	return {
		mcpServers: {
			meetings: {
				type: 'stdio',
				command: 'npx',
				args: [
					'-y',
					'fake-remote-proxy',
					'https://mcp.example.test/mcp',
					'--header',
					`Authorization: Bearer ${FAKE_ARG_TOKEN}`,
					'--region=eu',
				],
			},
		},
	}
}

describe('maskArgs', () => {
	it('masks only the secret part of header, flag and url forms', () => {
		expect(
			maskArgs([
				'Authorization: Bearer fake-1',
				'X-Api-Key: fake-2',
				'--token=fake-3',
				'FAKE_API_KEY=fake-4',
				'--api-key',
				'fake-5',
				'https://user:fake-6@mcp.example.test/mcp',
				'https://mcp.example.test/mcp?token=fake-7&region=eu',
			]),
		).toEqual([
			`Authorization: Bearer ${MASKED_VALUE}`,
			`X-Api-Key: ${MASKED_VALUE}`,
			`--token=${MASKED_VALUE}`,
			`FAKE_API_KEY=${MASKED_VALUE}`,
			'--api-key',
			MASKED_VALUE,
			`https://user:${MASKED_VALUE}@mcp.example.test/mcp`,
			`https://mcp.example.test/mcp?token=${MASKED_VALUE}&region=eu`,
		])
	})

	it('leaves non-secret args and env references alone', () => {
		const args = ['-y', 'fake-server', '--max-tokens=100', '--region=eu', 'Authorization: $AUTH']

		expect(maskArgs(args)).toEqual(args)
	})

	it('is idempotent', () => {
		const once = maskArgs(buildArgsTools().mcpServers.meetings.args)

		expect(maskArgs(once)).toEqual(once)
	})
})

describe('maskActorTools args', () => {
	it('masks the token in args and keeps the prefix, host, command and other args', () => {
		const masked = maskActorTools(buildArgsTools()) as ReturnType<typeof buildArgsTools>

		expect(masked.mcpServers.meetings.args).toEqual([
			'-y',
			'fake-remote-proxy',
			'https://mcp.example.test/mcp',
			'--header',
			`Authorization: Bearer ${MASKED_VALUE}`,
			'--region=eu',
		])
		expect(masked.mcpServers.meetings.command).toBe('npx')
		expect(JSON.stringify(masked)).not.toContain(FAKE_ARG_TOKEN)
	})

	it('does not mutate the stored config', () => {
		const tools = buildArgsTools()
		maskActorTools(tools)

		expect(tools.mcpServers.meetings.args[4]).toContain(FAKE_ARG_TOKEN)
	})
})

describe('restoreMaskedToolValues args', () => {
	it('puts the stored arg back when a masked config is sent back unchanged', () => {
		const stored = buildArgsTools()
		const incoming = maskActorTools(stored)

		const { tools, unresolved } = restoreMaskedToolValues(
			incoming as Record<string, unknown>,
			stored,
		)

		expect(unresolved).toEqual([])
		expect(tools).toEqual(stored)
	})

	it('keeps a real new token and an edited non-secret arg', () => {
		const stored = buildArgsTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildArgsTools>
		incoming.mcpServers.meetings.args[5] = '--region=us'
		incoming.mcpServers.meetings.args[4] = 'Authorization: Bearer fake-rotated'

		const { tools, unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual([])
		expect((tools.mcpServers as typeof stored.mcpServers).meetings.args.slice(4)).toEqual([
			'Authorization: Bearer fake-rotated',
			'--region=us',
		])
	})

	it('refuses to restore when the host in args was changed', () => {
		const stored = buildArgsTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildArgsTools>
		incoming.mcpServers.meetings.args[2] = 'https://attacker.example.test/mcp'

		const { tools, unresolved } = restoreMaskedToolValues(incoming, stored)

		expect(unresolved).toEqual(['meetings.args.4'])
		expect(JSON.stringify(tools)).not.toContain(FAKE_ARG_TOKEN)
	})

	it('refuses to restore when the secret-bearing arg was re-keyed', () => {
		const stored = buildArgsTools()
		const incoming = maskActorTools(stored) as ReturnType<typeof buildArgsTools>
		incoming.mcpServers.meetings.args[4] = `X-Forward-To: ${MASKED_VALUE}`

		expect(restoreMaskedToolValues(incoming, stored).unresolved).toEqual(['meetings.args.4'])
	})

	it('reports a masked arg when nothing is stored yet', () => {
		const incoming = maskActorTools(buildArgsTools()) as Record<string, unknown>

		expect(restoreMaskedToolValues(incoming, null).unresolved).toEqual(['meetings.args.4'])
	})
})
