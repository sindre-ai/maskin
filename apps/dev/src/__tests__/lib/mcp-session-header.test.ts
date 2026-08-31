import { describe, expect, it } from 'vitest'
import { stampMaskinSessionHeader } from '../../lib/mcp-session-header'

const maskinEntry = {
	type: 'http',
	url: '${MASKIN_API_URL}/mcp',
	headers: {
		Authorization: 'Bearer ${MASKIN_API_KEY}',
		'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
	},
}

describe('stampMaskinSessionHeader', () => {
	it('adds the session header to a Maskin MCP entry', () => {
		const out = stampMaskinSessionHeader({ maskin: maskinEntry })
		expect((out.maskin as { headers: Record<string, string> }).headers).toMatchObject({
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			'X-Maskin-Session-Id': '${SESSION_ID}',
		})
	})

	it('leaves the Slack integration MCP alone even though its url ends in /mcp', () => {
		const slack = {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
			headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
		}
		const out = stampMaskinSessionHeader({ slack })
		expect(out.slack).toBe(slack)
	})

	it('leaves third-party and stdio servers untouched', () => {
		const servers = {
			linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
			browser: { type: 'stdio', command: 'npx' },
		}
		expect(stampMaskinSessionHeader(servers)).toBe(servers)
	})

	it('does not overwrite an explicitly set session header', () => {
		const pinned = {
			...maskinEntry,
			headers: { ...maskinEntry.headers, 'X-Maskin-Session-Id': 'custom' },
		}
		const out = stampMaskinSessionHeader({ maskin: pinned })
		expect(out.maskin).toBe(pinned)
	})

	it('passes null and undefined through so callers keep their absent/empty distinction', () => {
		expect(stampMaskinSessionHeader(null)).toBeNull()
		expect(stampMaskinSessionHeader(undefined)).toBeUndefined()
	})
})
