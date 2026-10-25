import { describe, expect, it } from 'vitest'
import { MCP_CLIENTS, classifyMcpClient } from '../../../lib/analytics/mcp-client'

describe('classifyMcpClient', () => {
	it.each([
		['claude-cli/2.0.14 (external, cli)', 'claude_code'],
		['Claude-Code/1.2.3', 'claude_code'],
		['Cursor/0.45.1 (darwin arm64)', 'cursor'],
		['Mozilla/5.0 Cursor/1.0 Chrome/124.0 Electron/30.0 Safari/537.36', 'cursor'],
		['vscode-mcp/1.99.0', 'vscode'],
		['Visual Studio Code/1.99.0', 'vscode'],
		['Claude Desktop/0.9.1', 'claude_desktop'],
		['Claude/0.9.1 Chrome/124.0 Electron/30.0 Safari/537.36', 'claude_desktop'],
	])('maps %s to %s', (userAgent, expected) => {
		expect(classifyMcpClient(userAgent)).toBe(expected)
	})

	it('falls back to other for anything it does not recognise', () => {
		expect(classifyMcpClient('curl/8.4.0')).toBe('other')
		expect(classifyMcpClient('node')).toBe('other')
		expect(classifyMcpClient('Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0')).toBe('other')
		// Claude.ai connector traffic is not a known family yet; it must not be
		// swept into claude_desktop by a loose match on the word "claude".
		expect(classifyMcpClient('Claude-User/1.0 (+https://claude.ai)')).toBe('other')
	})

	it('falls back to other when there is no User-Agent', () => {
		expect(classifyMcpClient(undefined)).toBe('other')
		expect(classifyMcpClient(null)).toBe('other')
		expect(classifyMcpClient('')).toBe('other')
	})

	// The raw header must never come back out, whatever it contains.
	it('only ever returns a label from the fixed list', () => {
		const hostile = [
			'secret-token ank_0123456789abcdef Cursor/1.0',
			'user@example.com',
			'x'.repeat(5000),
		]
		for (const userAgent of hostile) {
			const result = classifyMcpClient(userAgent)
			expect(MCP_CLIENTS).toContain(result)
			expect(result).not.toContain('ank_')
		}
	})
})

describe('classifyMcpClient maskin_probe', () => {
	it('labels the production canary', () => {
		expect(classifyMcpClient('maskin-probe/1')).toBe('maskin_probe')
	})

	it('is first in the list, so it beats every other family', () => {
		expect(classifyMcpClient('maskin-probe/1 claude-cli/2.0.14')).toBe('maskin_probe')
		expect(classifyMcpClient('claude-cli/2.0.14 maskin-probe/1')).toBe('maskin_probe')
		expect(classifyMcpClient('Cursor/1.0 maskin-probe/1')).toBe('maskin_probe')
		expect(MCP_CLIENTS[0]).toBe('maskin_probe')
	})
})
