import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { integrationToolState } from '@/lib/integration-tool-state'
import { describe, expect, it } from 'vitest'

const LINEAR_URL = 'https://mcp.linear.app/mcp'

function provider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return {
		name: 'linear',
		displayName: 'Linear',
		authType: 'oauth2',
		events: [],
		mcp: {
			envKey: 'LINEAR_TOKEN',
			autoInject: false,
			server: { type: 'http', url: LINEAR_URL },
		},
		...overrides,
	}
}

function row(overrides: Partial<IntegrationResponse> = {}): IntegrationResponse {
	return {
		id: 'i-1',
		provider: 'linear',
		status: 'active',
		config: {},
		...overrides,
	} as IntegrationResponse
}

describe('integrationToolState', () => {
	it('is missing when the workspace has no row for the provider', () => {
		expect(
			integrationToolState({ provider: provider(), integrations: [], agentMcpServers: {} }),
		).toBe('missing')
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row({ provider: 'gmail' })],
				agentMcpServers: {},
			}),
		).toBe('missing')
	})

	it('treats an unfinished (pending) connect as missing', () => {
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row({ status: 'pending' })],
				agentMcpServers: {},
			}),
		).toBe('missing')
	})

	it('needs a reconnect when the row is revoked or awaiting a secret', () => {
		for (const status of ['revoked', 'awaiting_secret']) {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [row({ status })],
					agentMcpServers: {},
				}),
			).toBe('needs_reconnect')
		}
	})

	it('needs a reconnect when the live row is missing permissions, even if the agent has the tool', () => {
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row({ needsReconnect: true, missingScopes: ['read'] })],
				agentMcpServers: { linear: { type: 'http', url: LINEAR_URL } },
			}),
		).toBe('needs_reconnect')
		const slack = provider({
			name: 'slack',
			mcp: { envKey: 'SLACK_TOKEN', autoInject: true },
		})
		expect(
			integrationToolState({
				provider: slack,
				integrations: [
					row({ provider: 'slack', needsReconnect: true, missingScopes: ['channels:history'] }),
				],
				agentMcpServers: {},
			}),
		).toBe('needs_reconnect')
	})

	it('is connected but not on the agent when the agent has no matching server', () => {
		expect(
			integrationToolState({ provider: provider(), integrations: [row()], agentMcpServers: {} }),
		).toBe('connected_not_on_agent')
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row()],
				agentMcpServers: undefined,
			}),
		).toBe('connected_not_on_agent')
	})

	it('is ready when the agent holds a server keyed by the provider name', () => {
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row()],
				agentMcpServers: { linear: { type: 'http', url: 'https://elsewhere.example/mcp' } },
			}),
		).toBe('ready')
	})

	it('is ready when the agent holds a server at the catalog url under another key', () => {
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row()],
				agentMcpServers: { 'my-linear': { type: 'http', url: LINEAR_URL } },
			}),
		).toBe('ready')
	})

	it('is not ready for an unrelated server on the agent', () => {
		expect(
			integrationToolState({
				provider: provider(),
				integrations: [row()],
				agentMcpServers: { other: { type: 'http', url: 'https://other.example/mcp' } },
			}),
		).toBe('connected_not_on_agent')
	})

	describe('with the agent given, its access to the integration decides', () => {
		const agentId = 'agent-1'

		it('is connected but not on the agent when its own grant is none', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [
						row({
							defaultAgentAccess: 'read',
							agentGrants: [{ actorId: agentId, access: 'none' }],
						}),
					],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('connected_not_on_agent')
		})

		it('is connected but not on the agent when there is no grant and the default is none', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [row({ defaultAgentAccess: 'none', agentGrants: [] })],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('connected_not_on_agent')
		})

		it('is ready on the default access, with no entry on the agent itself', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [row({ defaultAgentAccess: 'read', agentGrants: [] })],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('ready')
		})

		it('is ready on its own grant even when the default is none', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [
						row({
							defaultAgentAccess: 'none',
							agentGrants: [{ actorId: agentId, access: 'read_write' }],
						}),
					],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('ready')
		})

		it('has sharing off when access is there but the workspace stopped sharing', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [
						row({ defaultAgentAccess: 'read', config: { expose_to_agent_sessions: false } }),
					],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('sharing_off')
		})

		it('keeps the old answer when the server sent no access fields', () => {
			expect(
				integrationToolState({
					provider: provider(),
					integrations: [row()],
					agentMcpServers: {},
					agentId,
				}),
			).toBe('connected_not_on_agent')
		})
	})

	describe('a provider injected into every agent session', () => {
		const slack = provider({
			name: 'slack',
			displayName: 'Slack',
			mcp: { envKey: 'SLACK_TOKEN', autoInject: true },
		})

		it('is ready once connected', () => {
			expect(
				integrationToolState({
					provider: slack,
					integrations: [row({ provider: 'slack' })],
					agentMcpServers: {},
				}),
			).toBe('ready')
		})

		it('has sharing off when the workspace switched exposure off', () => {
			expect(
				integrationToolState({
					provider: slack,
					integrations: [row({ provider: 'slack', config: { expose_to_agent_sessions: false } })],
					agentMcpServers: {},
				}),
			).toBe('sharing_off')
		})

		it('is still missing when not connected', () => {
			expect(integrationToolState({ provider: slack, integrations: [], agentMcpServers: {} })).toBe(
				'missing',
			)
		})
	})
})
