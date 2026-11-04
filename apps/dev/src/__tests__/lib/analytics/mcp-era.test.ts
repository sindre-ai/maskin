import { MCP_PROTOCOL_VERSION_LABELS } from '@maskin/shared'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import {
	MCP_PROTOCOL_VERSION_ALLOWLIST,
	MODERN_PROTOCOL_VERSION,
	classifyMcpEra,
	eraMethodOf,
} from '../../../lib/analytics/mcp-era'

function headers(version?: string) {
	return new Headers(version === undefined ? {} : { 'MCP-Protocol-Version': version })
}

describe('classifyMcpEra', () => {
	it.each([
		['2025-11-25', 'initialize', 'legacy'],
		['2025-06-18', 'tools/call', 'legacy'],
		['2024-11-05', 'tools/list', 'legacy'],
		['2026-07-28', 'tools/call', 'modern'],
		['2026-07-28', 'initialize', 'modern'],
	])('labels declared version %s on %s as %s with the same version', (version, method, era) => {
		expect(classifyMcpEra(headers(version), method)).toEqual({ era, version })
	})

	it('treats server/discover as modern whatever the header says', () => {
		expect(classifyMcpEra(headers(), 'server/discover')).toEqual({ era: 'modern', version: 'none' })
		expect(classifyMcpEra(headers('2025-06-18'), 'server/discover')).toEqual({
			era: 'modern',
			version: '2025-06-18',
		})
	})

	it('treats initialize with no header as legacy with version none', () => {
		expect(classifyMcpEra(headers(), 'initialize')).toEqual({ era: 'legacy', version: 'none' })
	})

	it('treats no header and no handshake as legacy with version none', () => {
		expect(classifyMcpEra(headers(), 'tools/call')).toEqual({ era: 'legacy', version: 'none' })
		expect(classifyMcpEra(headers(), undefined)).toEqual({ era: 'legacy', version: 'none' })
		expect(classifyMcpEra(headers('   '), 'tools/call')).toEqual({ era: 'legacy', version: 'none' })
	})

	it('maps a version outside the allowlist to other, never echoing it', () => {
		expect(classifyMcpEra(headers('1999-01-01'), 'tools/call')).toEqual({
			era: 'legacy',
			version: 'other',
		})
		// A future date is still modern: it must not be counted as legacy.
		expect(classifyMcpEra(headers('2027-03-01'), 'tools/call')).toEqual({
			era: 'modern',
			version: 'other',
		})
	})

	it('never returns raw header text, however hostile', () => {
		for (const raw of ['ank_0123456789abcdef', 'user@example.com', 'x'.repeat(5000)]) {
			const { era, version } = classifyMcpEra(headers(raw), 'tools/call')
			expect(era).toBe('legacy')
			expect(version).toBe('other')
		}
	})
})

describe('eraMethodOf', () => {
	it('returns the method of a single message', () => {
		expect(eraMethodOf({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toBe('tools/call')
	})

	it('lets a handshake method decide for a whole batch', () => {
		expect(
			eraMethodOf([
				{ jsonrpc: '2.0', id: 1, method: 'tools/call' },
				{ jsonrpc: '2.0', id: 2, method: 'server/discover' },
			]),
		).toBe('server/discover')
	})

	it('falls back to the first message and survives junk elements', () => {
		expect(eraMethodOf([null, 'x', { method: 'tools/list' }, { method: 'tools/call' }])).toBe(
			'tools/list',
		)
		expect(eraMethodOf(null)).toBeUndefined()
		expect(eraMethodOf([])).toBeUndefined()
	})
})

// If the SDK adds or drops a supported version, the allowlist follows it (it is
// built from the constant), but the static label list in @maskin/shared does
// not. This test fails until the two agree, so a new version cannot silently
// degrade to a missing label at the ingest boundary.
describe('protocol version allowlist', () => {
	it('is the SDK supported-versions constant plus 2026-07-28', () => {
		expect([...MCP_PROTOCOL_VERSION_ALLOWLIST].sort()).toEqual(
			[...SUPPORTED_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSION].sort(),
		)
	})

	it('matches the version labels the shared ingest schema accepts', () => {
		const versions = MCP_PROTOCOL_VERSION_LABELS.filter((l) => l !== 'other' && l !== 'none')
		expect([...versions].sort()).toEqual([...MCP_PROTOCOL_VERSION_ALLOWLIST].sort())
	})
})
