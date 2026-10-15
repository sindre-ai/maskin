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

	// The `tools` blob these entries come from is workspace-editable and
	// unschema'd, so `headers` is not guaranteed to be an object. Reaching the
	// `in` operator with a non-object throws a TypeError synchronously inside
	// launchContainer, failing the whole session launch over a stamping step
	// that only exists for analytics.
	it.each([
		['a string', 'not-an-object'],
		['a number', 42],
		['an array', ['Authorization: Bearer x']],
		['null', null],
	])('passes an entry through untouched when headers is %s', (_label, headers) => {
		const entry = { ...maskinEntry, headers }
		const input = { maskin: entry }
		expect(() => stampMaskinSessionHeader(input)).not.toThrow()
		expect(stampMaskinSessionHeader(input).maskin).toBe(entry)
	})

	it('stamps an entry that has no headers key at all', () => {
		const out = stampMaskinSessionHeader({
			maskin: { type: 'http', url: '${MASKIN_API_URL}/mcp' },
		})
		expect((out.maskin as { headers: Record<string, string> }).headers).toEqual({
			'X-Maskin-Session-Id': '${SESSION_ID}',
		})
	})

	// includeTriggeringEventId is passed by session-manager iff the session
	// carries `source_comment_event_id` (i.e. it was dispatched from a
	// comment). Only in that case does the container also get the matching
	// MASKIN_TRIGGERING_EVENT_ID env var — outside that case the placeholder
	// would substitute to empty and the /mcp route would ignore it, so the
	// header is left off entirely rather than shipped empty.
	it('stamps the triggering-event header when includeTriggeringEventId is true', () => {
		const out = stampMaskinSessionHeader(
			{ maskin: maskinEntry },
			{ includeTriggeringEventId: true },
		)
		expect((out.maskin as { headers: Record<string, string> }).headers).toMatchObject({
			'X-Maskin-Session-Id': '${SESSION_ID}',
			'X-Maskin-Triggering-Event-Id': '${MASKIN_TRIGGERING_EVENT_ID}',
		})
	})

	it('omits the triggering-event header when includeTriggeringEventId is false or missing', () => {
		const out = stampMaskinSessionHeader({ maskin: maskinEntry })
		const headers = (out.maskin as { headers: Record<string, string> }).headers
		expect(headers).not.toHaveProperty('X-Maskin-Triggering-Event-Id')
	})

	it('adds only the triggering header on an already-session-stamped entry', () => {
		const pinned = {
			...maskinEntry,
			headers: { ...maskinEntry.headers, 'X-Maskin-Session-Id': 'preset' },
		}
		const out = stampMaskinSessionHeader({ maskin: pinned }, { includeTriggeringEventId: true })
		const headers = (out.maskin as { headers: Record<string, string> }).headers
		// Explicit override wins for the session id …
		expect(headers['X-Maskin-Session-Id']).toBe('preset')
		// … but the triggering header still gets added when requested.
		expect(headers['X-Maskin-Triggering-Event-Id']).toBe('${MASKIN_TRIGGERING_EVENT_ID}')
	})

	it('leaves an entry alone when both headers are already present', () => {
		const pinned = {
			...maskinEntry,
			headers: {
				...maskinEntry.headers,
				'X-Maskin-Session-Id': 'preset',
				'X-Maskin-Triggering-Event-Id': '42',
			},
		}
		const out = stampMaskinSessionHeader({ maskin: pinned }, { includeTriggeringEventId: true })
		expect(out.maskin).toBe(pinned)
	})
})
