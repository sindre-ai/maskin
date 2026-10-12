import { describe, expect, it } from 'vitest'
import {
	MASKED_VALUE,
	hasSecretFields,
	maskActorTools,
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
