import { describe, expect, it } from 'vitest'
import {
	type McpServerHealthMap,
	applyMcpEnvelope,
	applyMcpToolUse,
	detectMcpToolUse,
	expireMcpPending,
	formatMcpHealthLine,
	hasPendingMcpServers,
	parseMcpInit,
	registerMcpInit,
} from '../../lib/mcp-health'

function initLine(servers: Array<{ name: string; status: string }>) {
	return JSON.stringify({
		type: 'system',
		subtype: 'init',
		session_id: '72a9280a-ae54-4ef8-8258-3e51a8dcb93a',
		tools: ['Bash'],
		mcp_servers: servers,
	})
}

function toolUseLine(toolName: string) {
	return JSON.stringify({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: {} }] },
	})
}

function register(servers: Array<{ name: string; status: string }>) {
	const health: McpServerHealthMap = new Map()
	const init = parseMcpInit(initLine(servers))
	if (!init) throw new Error('init line did not parse')
	const lines = registerMcpInit(health, init)
	return { health, lines }
}

describe('parseMcpInit', () => {
	it('returns every server in the envelope', () => {
		expect(
			parseMcpInit(
				initLine([
					{ name: 'maskin', status: 'connected' },
					{ name: 'playwright', status: 'pending' },
				]),
			),
		).toEqual([
			{ name: 'maskin', status: 'connected' },
			{ name: 'playwright', status: 'pending' },
		])
	})

	it('ignores non-init lines, malformed JSON, and missing fields', () => {
		expect(parseMcpInit('')).toBeNull()
		expect(parseMcpInit('{"type":"assistant","message":{}}')).toBeNull()
		// Looks like an init line but is truncated mid-write — must not throw.
		expect(parseMcpInit('{"subtype":"init","mcp_servers":[{"name":')).toBeNull()
		expect(
			parseMcpInit(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: 'nope' })),
		).toBeNull()
		expect(parseMcpInit(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toBeNull()
	})
})

describe('registerMcpInit', () => {
	// The shape that actually reached production: browser attached
	// running, playwright still booting, agent told the server "did not connect".
	it('reports pending and failed as two distinct states', () => {
		const { health, lines } = register([
			{ name: 'maskin', status: 'connected' },
			{ name: 'playwright', status: 'pending' },
			{ name: 'linear', status: 'failed' },
		])
		expect(health.get('playwright')?.state).toBe('pending')
		expect(health.get('linear')?.state).toBe('failed')
		expect(lines).toEqual([
			formatMcpHealthLine('pending', 'playwright'),
			formatMcpHealthLine('failed', 'linear'),
		])
		// "did not connect" is only ever the failed copy.
		expect(lines.filter((l) => l.includes('did not connect'))).toHaveLength(1)
		expect(lines[0]).toContain('not a failure')
		expect(lines[1]).toMatch(/^MCP server did not connect: linear/)
	})

	it('does not report a disabled server', () => {
		const { health, lines } = register([
			{ name: 'maskin', status: 'connected' },
			{ name: 'legacy', status: 'disabled' },
		])
		expect(lines).toEqual([])
		expect(health.size).toBe(0)
	})

	it('reports needs-auth with its own copy', () => {
		const { health, lines } = register([{ name: 'gmail', status: 'needs-auth' }])
		expect(health.get('gmail')?.state).toBe('needs-auth')
		expect(lines).toEqual([formatMcpHealthLine('needs-auth', 'gmail')])
		expect(lines[0]).toContain('needs authentication')
		expect(lines[0]).not.toContain('did not connect')
	})

	it('reports nothing when everything connected', () => {
		const { health, lines } = register([{ name: 'maskin', status: 'connected' }])
		expect(lines).toEqual([])
		expect(health.size).toBe(0)
	})
})

describe('detectMcpToolUse', () => {
	it('matches a tool_use block on the server prefix, including hyphenated names', () => {
		expect(
			detectMcpToolUse(toolUseLine('mcp__github-sindre-ai__get_file_contents'), [
				'github-sindre-ai',
				'playwright',
			]),
		).toEqual(['github-sindre-ai'])
	})

	it('does not match another server or a non-MCP tool', () => {
		expect(detectMcpToolUse(toolUseLine('mcp__maskin__get_objects'), ['playwright'])).toEqual([])
		expect(detectMcpToolUse(toolUseLine('Bash'), ['playwright'])).toEqual([])
		expect(detectMcpToolUse('not json mcp__playwright__x', ['playwright'])).toEqual([])
	})
})

describe('applyMcpToolUse', () => {
	it('moves a pending server to connected with exactly one correction line', () => {
		const { health } = register([
			{ name: 'maskin', status: 'connected' },
			{ name: 'playwright', status: 'pending' },
		])
		const first = applyMcpToolUse(health, toolUseLine('mcp__playwright__browser_navigate'))
		expect(first).toEqual([formatMcpHealthLine('connected', 'playwright')])
		expect(health.get('playwright')).toMatchObject({ state: 'connected', resolvedAt: 'resample' })
		expect(hasPendingMcpServers(health)).toBe(false)

		// The next tool call on the same server says nothing more.
		expect(applyMcpToolUse(health, toolUseLine('mcp__playwright__browser_click'))).toEqual([])
	})

	it('never downgrades connected when the init line is replayed', () => {
		const { health } = register([{ name: 'playwright', status: 'pending' }])
		applyMcpToolUse(health, toolUseLine('mcp__playwright__browser_navigate'))

		const replay = parseMcpInit(initLine([{ name: 'playwright', status: 'pending' }]))
		expect(replay).not.toBeNull()
		expect(applyMcpEnvelope(health, replay ?? [])).toEqual([])
		expect(health.get('playwright')?.state).toBe('connected')
	})
})

describe('applyMcpEnvelope', () => {
	it('moves a pending server to failed on a later envelope that says so', () => {
		const { health } = register([{ name: 'linear', status: 'pending' }])
		const later = parseMcpInit(initLine([{ name: 'linear', status: 'failed' }]))
		expect(applyMcpEnvelope(health, later ?? [])).toEqual([formatMcpHealthLine('failed', 'linear')])
		expect(health.get('linear')?.state).toBe('failed')
	})

	it('leaves a terminal server alone', () => {
		const { health } = register([{ name: 'linear', status: 'failed' }])
		const later = parseMcpInit(initLine([{ name: 'linear', status: 'connected' }]))
		expect(applyMcpEnvelope(health, later ?? [])).toEqual([])
		expect(health.get('linear')?.state).toBe('failed')
	})
})

describe('expireMcpPending', () => {
	it('labels a server still pending at the cap slow-unknown, never failed', () => {
		const { health } = register([
			{ name: 'playwright', status: 'pending' },
			{ name: 'linear', status: 'failed' },
		])
		const lines = expireMcpPending(health)
		expect(lines).toEqual([formatMcpHealthLine('slow-unknown', 'playwright')])
		expect(lines[0]).toContain('not a confirmed failure')
		expect(lines[0]).not.toMatch(/^MCP server did not connect/)
		expect(health.get('playwright')).toMatchObject({ state: 'slow-unknown', resolvedAt: 'cap' })
		// A failed server stays failed and is not re-reported.
		expect(health.get('linear')?.state).toBe('failed')
		expect(expireMcpPending(health)).toEqual([])
	})
})
