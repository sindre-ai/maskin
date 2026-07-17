import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS,
	detectChiefOfStaffDomainOutput,
	trackChiefOfStaffDomainOutputDetected,
} from '../../../lib/analytics/thinness-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

afterEach(() => {
	vi.restoreAllMocks()
})

function assistantEnvelope(
	content: Array<Record<string, unknown>>,
	overrides: Record<string, unknown> = {},
): string {
	return `${JSON.stringify({
		type: 'assistant',
		session_id: 'sess-1',
		message: {
			id: 'msg-1',
			content,
		},
		...overrides,
	})}\n`
}

describe('detectChiefOfStaffDomainOutput', () => {
	const longText = 'x'.repeat(CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS + 20)
	const shortText = 'ok, pulling in the Growth Strategist for that.'

	it('trips on a long CoS-authored assistant text with no summon in the same message', () => {
		const chunk = assistantEnvelope([{ type: 'text', text: longText }])

		const hit = detectChiefOfStaffDomainOutput(chunk)

		expect(hit).not.toBeNull()
		expect(hit?.chars).toBe(longText.length)
		expect(hit?.messageId).toBe('msg-1')
		expect(hit?.sessionId).toBe('sess-1')
	})

	it('does not trip when the same message also carries a run_agent tool_use', () => {
		// Precision > recall: any summon call in the same message makes the
		// long text preamble for a delegation, not standalone domain output.
		const chunk = assistantEnvelope([
			{ type: 'text', text: longText },
			{ type: 'tool_use', id: 't1', name: 'run_agent', input: {} },
		])

		expect(detectChiefOfStaffDomainOutput(chunk)).toBeNull()
	})

	it('recognises MCP-prefixed summon tool names', () => {
		const chunk = assistantEnvelope([
			{ type: 'text', text: longText },
			{ type: 'tool_use', id: 't1', name: 'mcp__maskin__create_session', input: {} },
		])

		expect(detectChiefOfStaffDomainOutput(chunk)).toBeNull()
	})

	it('does not trip on short greetings or clarifying questions', () => {
		const chunk = assistantEnvelope([{ type: 'text', text: shortText }])

		expect(detectChiefOfStaffDomainOutput(chunk)).toBeNull()
	})

	it('does not trip on non-assistant envelopes (system, result, user)', () => {
		const lines = [
			JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
			JSON.stringify({ type: 'result', subtype: 'end', is_error: false, result: longText }),
			JSON.stringify({
				type: 'user',
				message: { content: [{ type: 'tool_result', content: longText }] },
			}),
		].join('\n')

		expect(detectChiefOfStaffDomainOutput(lines)).toBeNull()
	})

	it('ignores malformed JSON lines mixed into the chunk', () => {
		const chunk = [
			'not json at all',
			'{"broken":',
			assistantEnvelope([{ type: 'text', text: longText }]),
		].join('\n')

		const hit = detectChiefOfStaffDomainOutput(chunk)

		expect(hit).not.toBeNull()
		expect(hit?.chars).toBe(longText.length)
	})

	it('sums text across multiple text blocks in the same assistant message', () => {
		const half = 'y'.repeat(Math.ceil(CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS / 2) + 1)
		const chunk = assistantEnvelope([
			{ type: 'text', text: half },
			{ type: 'text', text: half },
		])

		const hit = detectChiefOfStaffDomainOutput(chunk)

		expect(hit).not.toBeNull()
		expect(hit?.chars).toBe(half.length * 2)
	})

	it('returns null for empty input', () => {
		expect(detectChiefOfStaffDomainOutput('')).toBeNull()
		expect(detectChiefOfStaffDomainOutput('\n\n\n')).toBeNull()
	})
})

describe('trackChiefOfStaffDomainOutputDetected', () => {
	it('captures the event with actor as distinct_id and the property contract', async () => {
		await trackChiefOfStaffDomainOutputDetected({
			workspaceId: 'ws-1',
			sessionId: 'sess-1',
			actorId: 'actor-cos',
			chars: 512,
			messageId: 'msg-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'chief_of_staff_domain_output_detected',
			'actor-cos',
			{
				workspace_id: 'ws-1',
				session_id: 'sess-1',
				actor_id: 'actor-cos',
				chars: 512,
				message_id: 'msg-1',
				source: 'agent',
			},
		)
	})

	it('swallows capture failures — thinness telemetry must never break log ingest', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackChiefOfStaffDomainOutputDetected({
				workspaceId: 'ws-1',
				sessionId: 'sess-1',
				actorId: 'actor-cos',
				chars: 512,
				messageId: null,
			}),
		).resolves.toBeUndefined()
	})
})
