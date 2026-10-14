import { describe, expect, it } from 'vitest'
import { MCP_CLIENTS, oauthClientLabel } from '../../../lib/analytics/mcp-client'

describe('oauthClientLabel', () => {
	it('labels the allowlisted Claude client by the host of its client_id', () => {
		expect(oauthClientLabel('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude_ai')
		expect(oauthClientLabel('https://CLAUDE.AI/x')).toBe('claude_ai')
	})

	it('labels any other host, and anything that is not a URL, as other', () => {
		expect(oauthClientLabel('https://example.com/client')).toBe('other')
		expect(oauthClientLabel('https://claude.ai.evil.example/client')).toBe('other')
		expect(oauthClientLabel('not a url')).toBe('other')
		expect(oauthClientLabel('')).toBe('other')
	})

	it('only ever returns a label from the fixed list', () => {
		for (const clientId of ['https://claude.ai/a', 'https://x.test/ank_secret', 'ank_secret']) {
			const label = oauthClientLabel(clientId)
			expect(MCP_CLIENTS).toContain(label)
			expect(label).not.toContain('ank_')
		}
	})
})
