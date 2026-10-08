import { segmentActivityByMessage } from '@/components/agents/session-log-transcript'
import type { SessionLogResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'
// Backend port of the same logic (GET /api/sessions/:id/activity). Pure module,
// type-only imports, so it is safe to load from the web test runner.
import { buildSessionActivity } from '../../../../../dev/src/lib/session-activity'

/**
 * Feeds the SAME log rows through the web's segmentActivityByMessage and the
 * backend's buildSessionActivity and asserts the step labels are identical, so
 * the iOS app (backend) and web never show different words for one session.
 */
const long = 'word '.repeat(60)
const env = (o: unknown) => JSON.stringify(o)
const rows: Array<[number, 'stdout' | 'stderr', string]> = [
	[1, 'stdout', env({ type: 'user', maskin_message_id: 7, message: { content: 'hi' } })],
	[
		2,
		'stdout',
		env({
			type: 'assistant',
			message: {
				id: 'm',
				content: [
					{ type: 'thinking', thinking: 'hmm' },
					{ type: 'thinking', thinking: '', signature: 'sig' },
					{ type: 'text', text: `  multi\n line   ${long}` },
					{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
					{ type: 'tool_use', id: 't2', name: 'mcp__maskin__get_objects', input: {} },
					{ type: 'tool_use', name: 'NoId', input: {} },
				],
			},
		}),
	],
	[3, 'stderr', `line one\nline two ${long}${long}`],
	[4, 'stdout', env({ type: 'error', message: `bad\n  thing ${long}` })],
	[5, 'stdout', env({ type: 'error' })],
	[
		6,
		'stdout',
		env({
			type: 'assistant',
			message: {
				id: 'm2',
				content: [
					{ type: 'tool_use', id: 't3', name: 'mcp__maskin__post_conversation_message', input: {} },
					{ type: 'text', text: 'wrap-up that restates the reply' },
				],
			},
		}),
	],
	[7, 'stdout', env({ type: 'result', subtype: 'success', is_error: false, result: 'done' })],
]

describe('activity label parity (web vs backend)', () => {
	it('produces identical step labels for the same session logs', () => {
		const webLogs: SessionLogResponse[] = rows.map(([id, stream, content]) => ({
			id,
			sessionId: 's',
			stream,
			content,
			createdAt: null,
		}))
		const web = segmentActivityByMessage(webLogs).segments[0]
		const backend = buildSessionActivity(
			rows.map(([id, stream, content]) => ({ id, stream, content, createdAt: null })),
		)[0]

		expect(backend.steps.map((s) => s.label)).toEqual(web.steps.map((s) => s.text))
		expect(backend.steps.map((s) => s.id)).toEqual(web.steps.map((s) => s.id))
		expect(backend.contains_reply).toBe(web.containsReply)
		expect(backend.result?.text).toBe(web.result?.text)
		// Sanity: the fixture exercised the interesting branches.
		expect(backend.steps.map((s) => s.label)).toContain('Using mcp__maskin__get_objects')
		expect(backend.steps.map((s) => s.label)).toContain('unknown error')
		expect(backend.steps.map((s) => s.label)).toContain('Replied to the conversation.')
	})
})
