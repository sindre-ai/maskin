import type { ExtensionAttempted, ExtensionResponse } from '@/lib/api'
import {
	allowedToolNames,
	blockedAttempts,
	declaredTools,
	grantEffect,
	initialSelection,
} from '@/lib/extension-grants'
import { describe, expect, it } from 'vitest'

const TOOLS = [
	{ name: 'get_transcript', kind: 'read' },
	{ name: 'list_transcripts', kind: 'read' },
	{ name: 'bookmark_meeting', kind: 'write' },
]

type GrantsRow = Pick<ExtensionResponse, 'mcpConfig' | 'toolGrants'>

function ext(toolGrants: ExtensionResponse['toolGrants'] = {}): GrantsRow {
	return { mcpConfig: { tools: TOOLS }, toolGrants }
}

describe('grantEffect', () => {
	it('reads the plain string and the object form alike', () => {
		expect(grantEffect('allow')).toBe('allow')
		expect(grantEffect({ effect: 'deny', expires_at: null, grant_id: 'g1' })).toBe('deny')
	})
})

describe('declaredTools', () => {
	it('returns the declared tools, and nothing for a missing or malformed config', () => {
		expect(declaredTools(ext()).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
		expect(declaredTools({ mcpConfig: null })).toEqual([])
		expect(declaredTools({ mcpConfig: { tools: 'nope' } })).toEqual([])
		expect(declaredTools({ mcpConfig: { tools: [{ name: 'x', kind: 'maybe' }, null] } })).toEqual(
			[],
		)
	})
})

describe('allowedToolNames', () => {
	it('is empty for an agent with no entry (default deny)', () => {
		expect(allowedToolNames(ext(), 'a1')).toEqual([])
	})

	it('lists only declared tools that are allowed', () => {
		const e = ext({
			a1: { get_transcript: 'allow', bookmark_meeting: 'deny', retired_tool: 'allow' },
		})
		expect(allowedToolNames(e, 'a1')).toEqual(['get_transcript'])
	})
})

describe('blockedAttempts', () => {
	const attempted: ExtensionAttempted = {
		windowDays: 30,
		agents: [
			{
				agentId: 'a1',
				tools: ['bookmark_meeting', 'get_transcript'],
				lastAttemptedAt: '2026-10-19T06:00:00Z',
			},
		],
	}

	it('is null when the agent has no recorded refusal', () => {
		expect(blockedAttempts(ext(), 'a2', attempted)).toBeNull()
		expect(blockedAttempts(ext(), 'a1', undefined)).toBeNull()
	})

	it('lists the refused tools the agent still cannot call', () => {
		expect(blockedAttempts(ext(), 'a1', attempted)).toEqual({
			tools: ['bookmark_meeting', 'get_transcript'],
			lastAttemptedAt: '2026-10-19T06:00:00Z',
		})
	})

	it('drops tools that have since been granted, and clears once none are left', () => {
		const partly = ext({ a1: { get_transcript: 'allow' } })
		expect(blockedAttempts(partly, 'a1', attempted)?.tools).toEqual(['bookmark_meeting'])
		const all = ext({ a1: { get_transcript: 'allow', bookmark_meeting: 'allow' } })
		expect(blockedAttempts(all, 'a1', attempted)).toBeNull()
	})
})

describe('initialSelection', () => {
	it('pre-checks read tools and leaves write tools off for an agent with no entry', () => {
		expect(initialSelection(ext(), 'a1')).toEqual({
			get_transcript: true,
			list_transcripts: true,
			bookmark_meeting: false,
		})
	})

	it('starts from the stored choices when the agent already has an entry', () => {
		const e = ext({ a1: { get_transcript: 'deny', bookmark_meeting: 'allow' } })
		expect(initialSelection(e, 'a1')).toEqual({
			get_transcript: false,
			list_transcripts: true,
			bookmark_meeting: true,
		})
	})
})
