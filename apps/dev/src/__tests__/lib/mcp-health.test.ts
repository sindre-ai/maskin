import { describe, expect, it } from 'vitest'
import { detectUnhealthyMcpServers, formatUnhealthyMcpWarning } from '../../lib/mcp-health'

function initLine(servers: Array<{ name: string; status: string }>) {
	return JSON.stringify({
		type: 'system',
		subtype: 'init',
		session_id: '72a9280a-ae54-4ef8-8258-3e51a8dcb93a',
		tools: ['Bash'],
		mcp_servers: servers,
	})
}

describe('detectUnhealthyMcpServers', () => {
	// The shape that actually reached production: sidecar attached, browser
	// running, playwright server never connected, agent reports no browser.
	it('flags a server stuck at pending while its peers are connected', () => {
		const out = detectUnhealthyMcpServers(
			initLine([
				{ name: 'exa', status: 'connected' },
				{ name: 'maskin', status: 'connected' },
				{ name: 'playwright', status: 'pending' },
			]),
		)
		expect(out).toEqual([{ name: 'playwright', status: 'pending' }])
	})

	it('flags failed servers and reports every unhealthy one', () => {
		const out = detectUnhealthyMcpServers(
			initLine([
				{ name: 'playwright', status: 'failed' },
				{ name: 'maskin', status: 'connected' },
				{ name: 'linear', status: 'pending' },
			]),
		)
		expect(out).toEqual([
			{ name: 'playwright', status: 'failed' },
			{ name: 'linear', status: 'pending' },
		])
	})

	it('returns null when everything connected', () => {
		expect(
			detectUnhealthyMcpServers(initLine([{ name: 'maskin', status: 'connected' }])),
		).toBeNull()
	})

	it('ignores non-init lines, malformed JSON, and missing fields', () => {
		expect(detectUnhealthyMcpServers('')).toBeNull()
		expect(detectUnhealthyMcpServers('{"type":"assistant","message":{}}')).toBeNull()
		// Looks like an init line but is truncated mid-write — must not throw.
		expect(detectUnhealthyMcpServers('{"subtype":"init","mcp_servers":[{"name":')).toBeNull()
		expect(
			detectUnhealthyMcpServers(
				JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: 'nope' }),
			),
		).toBeNull()
		expect(
			detectUnhealthyMcpServers(JSON.stringify({ type: 'system', subtype: 'compact_boundary' })),
		).toBeNull()
	})
})

describe('formatUnhealthyMcpWarning', () => {
	it('names the servers and says the tools are missing', () => {
		const msg = formatUnhealthyMcpWarning([{ name: 'playwright', status: 'pending' }])
		expect(msg).toContain('playwright (pending)')
		expect(msg).toContain('tools are unavailable')
		expect(msg).toMatch(/^MCP server did not connect/)
	})

	it('pluralises for several servers', () => {
		const msg = formatUnhealthyMcpWarning([
			{ name: 'playwright', status: 'pending' },
			{ name: 'linear', status: 'failed' },
		])
		expect(msg).toMatch(/^MCP servers did not connect/)
		expect(msg).toContain('linear (failed)')
	})
})
