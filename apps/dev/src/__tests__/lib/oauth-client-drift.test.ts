import { MCP_OAUTH_PINNED_CLAUDE_CLIENT } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { diffClientRecord } from '../../lib/oauth-server/client-drift'

// The document Claude published when the pin was taken (2026-10-13 10:51Z).
const LIVE = {
	client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
	client_name: 'Claude',
	client_uri: 'https://claude.ai',
	redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
	grant_types: [
		'authorization_code',
		'refresh_token',
		'urn:ietf:params:oauth:grant-type:jwt-bearer',
	],
	response_types: ['code'],
	token_endpoint_auth_method: 'none',
}

describe('diffClientRecord', () => {
	it('finds nothing when the live document matches the pin', () => {
		expect(diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, LIVE)).toEqual([])
	})

	it('ignores list order and unknown extra fields', () => {
		const live = {
			...LIVE,
			grant_types: [...LIVE.grant_types].reverse(),
			logo_uri: 'https://claude.ai/logo.png',
		}
		expect(diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, live)).toEqual([])
	})

	it('reports a changed redirect address', () => {
		const live = { ...LIVE, redirect_uris: ['https://claude.ai/api/mcp/auth_callback_v2'] }
		const differences = diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, live)

		expect(differences).toHaveLength(1)
		expect(differences[0]).toContain('redirect_uris')
	})

	it('reports an added redirect address and a changed name', () => {
		const live = {
			...LIVE,
			client_name: 'Claude AI',
			redirect_uris: [...LIVE.redirect_uris, 'https://claude.com/api/mcp/auth_callback'],
		}
		const differences = diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, live)

		expect(differences.map((d) => d.split(':')[0]).sort()).toEqual(['client_name', 'redirect_uris'])
	})

	it('reports a missing or malformed list', () => {
		const { grant_types: _omitted, ...withoutGrants } = LIVE
		expect(diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, withoutGrants)[0]).toContain(
			'grant_types',
		)
		expect(
			diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, { ...LIVE, response_types: 'code' })[0],
		).toContain('response_types')
	})

	it.each([null, 'text', 42, [LIVE]])(
		'reports a live document that is not an object: %j',
		(live) => {
			expect(diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, live)).toEqual([
				'the live document is not a JSON object',
			])
		},
	)
})
