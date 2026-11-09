import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('../../../../lib/events/record-event', () => ({
	recordEvent: vi.fn(async () => {}),
}))

import type { AgentAccess } from '../../../../lib/integrations/agent-access'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/stripe/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { gateMcpServer } from '../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

// The tool list from https://docs.stripe.com/mcp (checked 9 Nov 2026).
const READ_TOOLS = [
	'stripe_api_search',
	'stripe_api_details',
	'stripe_api_read',
	'get_stripe_account_info',
	'get_balance_summary',
	'search_stripe_documentation',
]
const WRITE_TOOLS = [
	'stripe_api_write',
	'atlas_company_formation',
	'stripe_analytics',
	'convert_currency',
	'send_money',
	'setup_recipient',
	'transfer_money',
	'stripe_implementation_planner',
	'send_stripe_feedback',
]

describe('Stripe provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('stripe')
		expect(config.displayName).toBe('Stripe')
	})

	it('signs in at access.stripe.com as a public client: PKCE, one scope, no secret', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://access.stripe.com/mcp/oauth2/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe('https://access.stripe.com/mcp/oauth2/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['mcp'])
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.clientIdEnv).toBe('STRIPE_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
		}
	})

	it('declares the hosted MCP server on a different host from sign-in, and its token variable', () => {
		expect(config.mcp?.envKey).toBe('STRIPE_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.stripe.com',
			headers: { Authorization: 'Bearer ${STRIPE_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('stripe').config).toBe(config)
	})
})

describe('Stripe through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('stripe')).toBe(true)
	})

	it('reads only the curated tools and treats every other Stripe tool as a write', () => {
		for (const tool of READ_TOOLS) expect(classifyTool('stripe', tool), tool).toBe('read')
		for (const tool of WRITE_TOOLS) expect(classifyTool('stripe', tool), tool).toBe('write')
		// A tool nobody has seen is a write, and no hint can talk a write into being a read.
		expect(classifyTool('stripe', 'create_refund')).toBe('write')
		expect(classifyTool('stripe', 'list_customers', { readOnlyHint: true })).toBe('write')
		expect(classifyTool('stripe', 'stripe_api_write', { readOnlyHint: true })).toBe('write')
	})
})

describe('a Read agent on Stripe (through a real MCP client)', () => {
	async function connect(access: AgentAccess) {
		const server = new McpServer({ name: 'test', version: '0.0.0' })
		gateMcpServer(server, {
			db: {} as Database,
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			integrationId: 'int-1',
			provider: 'stripe',
			providerLabel: 'Stripe',
			access,
		})
		const handlers = new Map<string, ReturnType<typeof vi.fn>>()
		for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
			const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
			handlers.set(name, handler)
			server.registerTool(
				name,
				{ description: name, inputSchema: { q: z.string().optional() } },
				handler,
			)
		}
		const client = new Client({ name: 'c', version: '0.0.0' })
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([server.connect(a), client.connect(b)])
		return { client, handlers }
	}

	it('can read, and is refused every tool that writes, without the handler running', async () => {
		const { client, handlers } = await connect('read')
		for (const name of READ_TOOLS) {
			expect((await client.callTool({ name, arguments: {} })).isError, name).toBeFalsy()
		}
		for (const name of WRITE_TOOLS) {
			const denied = await client.callTool({ name, arguments: {} })
			expect(denied.isError, name).toBe(true)
			expect(handlers.get(name), name).not.toHaveBeenCalled()
		}
	})

	it('lets a Read & write agent call a write tool', async () => {
		const { client, handlers } = await connect('read_write')
		expect((await client.callTool({ name: 'stripe_api_write', arguments: {} })).isError).toBeFalsy()
		expect(handlers.get('stripe_api_write')).toHaveBeenCalledOnce()
	})
})
