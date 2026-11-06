import { MCP_OAUTH_CLAUDE_CLIENT_ID, MCP_OAUTH_PINNED_CLAUDE_CLIENT } from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'
import {
	resolvePinnedClient,
	supportsAuthorizationCodeFlow,
} from '../../lib/oauth-server/client-record'

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

describe('resolvePinnedClient', () => {
	it('accepts the exact Claude client_id with its pinned redirect_uri', () => {
		const result = resolvePinnedClient(MCP_OAUTH_CLAUDE_CLIENT_ID, CLAUDE_REDIRECT)

		expect(result).toEqual({ ok: true, client: MCP_OAUTH_PINNED_CLAUDE_CLIENT })
		expect(result.ok && result.client.client_name).toBe('Claude')
	})

	it.each([
		['a trailing slash', `${MCP_OAUTH_CLAUDE_CLIENT_ID}/`],
		['a trailing dot in the host', 'https://claude.ai./oauth/mcp-oauth-client-metadata'],
		['a different case', 'https://Claude.ai/oauth/mcp-oauth-client-metadata'],
		['an explicit default port', 'https://claude.ai:443/oauth/mcp-oauth-client-metadata'],
		['a different path', 'https://claude.ai/oauth/other-client'],
	])('rejects a client_id with %s', (_name, clientId) => {
		expect(resolvePinnedClient(clientId, CLAUDE_REDIRECT)).toEqual({
			ok: false,
			error: 'client_not_allowlisted',
		})
	})

	it('rejects an unknown client, including one named like an Object prototype key', () => {
		for (const clientId of ['https://example.com/client.json', '', '__proto__', 'constructor']) {
			expect(resolvePinnedClient(clientId, CLAUDE_REDIRECT)).toEqual({
				ok: false,
				error: 'client_not_allowlisted',
			})
		}
	})

	it.each([
		['another host', 'https://evil.example/api/mcp/auth_callback'],
		['http instead of https', 'http://claude.ai/api/mcp/auth_callback'],
		['a trailing slash', `${CLAUDE_REDIRECT}/`],
		['a query string', `${CLAUDE_REDIRECT}?x=1`],
		['a different path', 'https://claude.ai/api/mcp/other_callback'],
		['an empty value', ''],
	])('rejects a redirect_uri with %s', (_name, redirectUri) => {
		expect(resolvePinnedClient(MCP_OAUTH_CLAUDE_CLIENT_ID, redirectUri)).toEqual({
			ok: false,
			error: 'bad_redirect_uri',
		})
	})

	it('checks client_id before redirect_uri, so a wrong client with a hostile redirect is an identity error', () => {
		expect(
			resolvePinnedClient('https://example.com/client.json', 'https://evil.example/cb'),
		).toEqual({
			ok: false,
			error: 'client_not_allowlisted',
		})
	})

	it('tolerates the extra jwt-bearer grant type Claude lists', () => {
		expect(MCP_OAUTH_PINNED_CLAUDE_CLIENT.grant_types).toContain(
			'urn:ietf:params:oauth:grant-type:jwt-bearer',
		)
		expect(supportsAuthorizationCodeFlow(MCP_OAUTH_PINNED_CLAUDE_CLIENT)).toBe(true)
		expect(resolvePinnedClient(MCP_OAUTH_CLAUDE_CLIENT_ID, CLAUDE_REDIRECT).ok).toBe(true)
	})

	it('refuses a record that cannot run the code flow without a client secret', () => {
		const id = 'https://example.com/client.json'
		const base = { ...MCP_OAUTH_PINNED_CLAUDE_CLIENT, client_id: id }
		for (const broken of [
			{ ...base, grant_types: ['refresh_token'] },
			{ ...base, response_types: ['token'] },
			{ ...base, token_endpoint_auth_method: 'client_secret_basic' },
		]) {
			expect(resolvePinnedClient(id, CLAUDE_REDIRECT, { [id]: broken })).toEqual({
				ok: false,
				error: 'client_not_allowlisted',
			})
		}
	})

	it('makes no outbound request', () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		resolvePinnedClient('https://example.com/client.json', CLAUDE_REDIRECT)
		resolvePinnedClient(MCP_OAUTH_CLAUDE_CLIENT_ID, CLAUDE_REDIRECT)
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})
})
