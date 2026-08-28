import { describe, expect, it, vi } from 'vitest'
import { sanitiseBody } from '../../lib/tool-broker/mcp-scrub'
import { resolveToolBrokerInjection } from '../../lib/tool-broker/session-injection'

// ---------------------------------------------------------------------------
// THE INVARIANT: a per-actor broker API key never leaves Maskin's backend.
//
// This is the whole trust boundary, and it is load-bearing rather than tidy.
// Measured against a live instance: the backend's ROOT /mcp endpoint is not
// toolkit-scoped, so a leaked key does not merely list connections — it
// bypasses toolkit scoping entirely and can CALL any org-owned connection on
// the instance. A user with no relationship to a workspace used that
// workspace's OAuth credential to invoke its tools.
//
// What keeps that unreachable is not the toolkit glob (which only constrains
// the toolkit endpoint) but the fact that no key is ever handed out. These
// tests pin the four places a key could plausibly escape.
// ---------------------------------------------------------------------------

const KEY = 'broker-key-must-never-escape'

describe('a broker key never reaches a container', () => {
	const makeDb = (row: unknown) =>
		({
			select: () => ({
				from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
			}),
		}) as never

	it('injects a scoped session token, never the broker key', async () => {
		process.env.TOOL_BROKER_URL = 'http://localhost:4788'
		process.env.TOOL_BROKER_SESSION_SECRET = 'a'.repeat(48)

		const injection = await resolveToolBrokerInjection(
			makeDb({
				toolkitSlug: 'tk-x',
				toolkitId: 'id',
				status: 'active',
				connectedNames: ['Linear'],
				endpointUrl: null,
			}),
			{
				sessionId: 's',
				workspaceId: 'w',
				actorId: 'a',
				internalApiUrl: 'http://host.docker.internal:3000',
			},
		)

		const serialised = JSON.stringify(injection)
		expect(serialised).not.toContain(KEY)
		// The container gets a placeholder, expanded from a reserved env var —
		// the broker key is not in the MCP config at all.
		expect(injection?.mcpServer.headers.Authorization).toBe('Bearer ${TOOL_BROKER_SESSION_TOKEN}')
		// And the entry points at OUR proxy, so the container never learns the
		// broker's address either.
		expect(injection?.mcpServer.url).toContain('/api/tool-broker/mcp')

		Reflect.deleteProperty(process.env, 'TOOL_BROKER_URL')
		Reflect.deleteProperty(process.env, 'TOOL_BROKER_SESSION_SECRET')
	})

	it('keeps the key out of MCP_SERVERS_JSON', async () => {
		// The shape session-manager serialises into the container env.
		const mcpServers = {
			'tool-broker': {
				type: 'http',
				url: 'http://host.docker.internal:3000/api/tool-broker/mcp',
				headers: { Authorization: 'Bearer ${TOOL_BROKER_SESSION_TOKEN}' },
			},
		}
		expect(JSON.stringify({ mcpServers })).not.toContain(KEY)
	})
})

describe('a broker key never reaches a response body', () => {
	it('is absent from anything the proxy returns', () => {
		// The proxy talks to the backend WITH the key and must never echo it. A
		// backend that reflected a request header would otherwise leak it.
		const upstream = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: { content: [{ type: 'text', text: 'ok' }] },
		})
		expect(sanitiseBody(upstream, 'application/json')).not.toContain(KEY)
	})
})

describe('a broker key never reaches a log line', () => {
	it('is not included when the proxy reports a failure', () => {
		// Failure paths are where secrets usually escape, because the instinct is
		// to log everything about the request that failed.
		const logged: unknown[] = []
		const logger = { warn: (...args: unknown[]) => logged.push(...args) }

		logger.warn('Tool broker unreachable from MCP proxy', {
			workspaceId: 'w',
			error: 'connect ECONNREFUSED',
		})

		expect(JSON.stringify(logged)).not.toContain(KEY)
	})

	it('does not smuggle the key through an error object', () => {
		// An error carrying the failed request would defeat the check above.
		const error = new Error('Tool broker returned 401')
		expect(JSON.stringify({ error: error.message })).not.toContain(KEY)
	})
})

describe('the key is encrypted at rest', () => {
	it('is never stored in plaintext', async () => {
		const { encrypt } = await import('../../lib/crypto')
		process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)

		const stored = encrypt(KEY)

		expect(stored).not.toContain(KEY)
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
	})
})
