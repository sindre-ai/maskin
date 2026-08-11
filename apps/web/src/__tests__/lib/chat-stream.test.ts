import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseChatLine, parseChatStream } from '@/lib/chat-stream'
import { describe, expect, it } from 'vitest'

const FIXTURES_DIR = join(__dirname, 'fixtures', 'chat-stream')

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')
}

function loadFixtureAsLine(name: string): string {
	return JSON.stringify(JSON.parse(loadFixture(name)))
}

describe('parseChatLine', () => {
	it('parses a system init envelope into a system event', () => {
		const events = parseChatLine(loadFixtureAsLine('system-init'))
		expect(events).toHaveLength(1)
		const [event] = events
		expect(event.kind).toBe('system')
		if (event.kind !== 'system') throw new Error('unreachable')
		expect(event.subtype).toBe('init')
		expect(event.sessionId).toBe('sess-chat-123')
		expect(event.data.tools).toEqual(['list_objects', 'search_objects'])
	})

	it('parses an assistant text block into a text event', () => {
		const events = parseChatLine(loadFixtureAsLine('assistant-text'))
		expect(events).toEqual([
			{
				kind: 'text',
				text: 'Looking at your workspace now…',
				sessionId: 'sess-chat-123',
				messageId: 'msg_01ABC',
			},
		])
	})

	it('parses an assistant tool_use block into a tool_use event', () => {
		const events = parseChatLine(loadFixtureAsLine('assistant-tool-use'))
		expect(events).toEqual([
			{
				kind: 'tool_use',
				id: 'toolu_01xyz',
				name: 'list_objects',
				input: { type: 'bet', limit: 5 },
				sessionId: 'sess-chat-123',
				messageId: 'msg_01TOOL',
			},
		])
	})

	it('parses an assistant thinking block into a thinking event', () => {
		const events = parseChatLine(loadFixtureAsLine('assistant-thinking'))
		expect(events).toEqual([
			{
				kind: 'thinking',
				text: 'User is asking about workspace state — I should call list_objects first.',
				sessionId: 'sess-chat-123',
				messageId: 'msg_01THINK',
			},
		])
	})

	it('splits a multi-block assistant message into one event per block, preserving order', () => {
		const events = parseChatLine(loadFixtureAsLine('assistant-multi-block'))
		expect(events.map((e) => e.kind)).toEqual(['thinking', 'text', 'tool_use'])
		const thinking = events[0]
		const text = events[1]
		const toolUse = events[2]
		if (thinking.kind !== 'thinking') throw new Error('unreachable')
		expect(thinking.text).toBe('Let me check the workspace first.')
		if (text.kind !== 'text') throw new Error('unreachable')
		expect(text.text).toBe('One sec — checking.')
		if (toolUse.kind !== 'tool_use') throw new Error('unreachable')
		expect(toolUse.name).toBe('search_objects')
		expect(toolUse.input).toEqual({ query: 'workspace' })
	})

	it('attaches maskin_attachments to the assistant text event so agent-referenced items render', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				role: 'assistant',
				id: 'msg_01REF',
				content: [{ type: 'text', text: 'See the bet below.' }],
			},
			maskin_attachments: [
				{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
				{ kind: 'file', id: 'file-uuid-1', name: 'report.pdf', size_bytes: 2048 },
			],
		})
		expect(parseChatLine(line)).toEqual([
			{
				kind: 'text',
				text: 'See the bet below.',
				messageId: 'msg_01REF',
				attachments: [
					{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
					{ kind: 'file', id: 'file-uuid-1', name: 'report.pdf', sizeBytes: 2048 },
				],
			},
		])
	})

	it('does not emit attachments when an assistant message has no text block', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				role: 'assistant',
				id: 'msg_01TOOL',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_01xyz',
						name: 'list_objects',
						input: { type: 'bet', limit: 5 },
					},
				],
			},
			maskin_attachments: [{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' }],
		})
		expect(parseChatLine(line)).toEqual([
			{
				kind: 'tool_use',
				id: 'toolu_01xyz',
				name: 'list_objects',
				input: { type: 'bet', limit: 5 },
				messageId: 'msg_01TOOL',
			},
		])
	})

	it('emits no events for user echoes so tool results are not duplicated', () => {
		const events = parseChatLine(loadFixtureAsLine('user-tool-result'))
		expect(events).toEqual([])
	})

	it('emits a user event when includeUser is set and content is a string', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'Hi Sindre — what is up?' },
		})
		expect(parseChatLine(line, { includeUser: true })).toEqual([
			{ kind: 'user', text: 'Hi Sindre — what is up?' },
		])
	})

	it('emits a user event when includeUser is set and content has text blocks', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'first line' }] },
		})
		expect(parseChatLine(line, { includeUser: true })).toEqual([
			{ kind: 'user', text: 'first line' },
		])
	})

	it('still skips tool_result-only user echoes when includeUser is set', () => {
		const events = parseChatLine(loadFixtureAsLine('user-tool-result'), { includeUser: true })
		expect(events).toEqual([])
	})

	// AC-T2: the persisted user envelope carries a `maskin_attachments` array
	// so reload can rebuild the user bubble — including inline file cards —
	// without re-uploading the bytes.
	it('reads maskin_attachments off a user envelope and emits them on the user event', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'look at this' },
			maskin_attachments: [
				{
					kind: 'file',
					id: 'file-uuid-1',
					name: 'photo.png',
					mime_type: 'image/png',
					size_bytes: 1234,
				},
				{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
			],
		})
		expect(parseChatLine(line, { includeUser: true })).toEqual([
			{
				kind: 'user',
				text: 'look at this',
				attachments: [
					{
						kind: 'file',
						id: 'file-uuid-1',
						name: 'photo.png',
						mimeType: 'image/png',
						sizeBytes: 1234,
					},
					{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
				],
			},
		])
	})

	it('emits a user event for an image-only message even when content is empty', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: '' },
			maskin_attachments: [
				{
					kind: 'file',
					id: 'file-uuid-2',
					name: 'shot.png',
					mime_type: 'image/png',
					size_bytes: 9,
				},
			],
		})
		expect(parseChatLine(line, { includeUser: true })).toEqual([
			{
				kind: 'user',
				text: '',
				attachments: [
					{
						kind: 'file',
						id: 'file-uuid-2',
						name: 'shot.png',
						mimeType: 'image/png',
						sizeBytes: 9,
					},
				],
			},
		])
	})

	it('parses a successful result envelope into a result event', () => {
		const events = parseChatLine(loadFixtureAsLine('result-success'))
		expect(events).toEqual([
			{
				kind: 'result',
				subtype: 'success',
				isError: false,
				text: 'You have 3 active bets, 12 tasks in progress.',
				durationMs: 1823,
				numTurns: 2,
				totalCostUsd: 0.00091,
				sessionId: 'sess-chat-123',
			},
		])
	})

	it('parses an errored result envelope with is_error=true', () => {
		const events = parseChatLine(loadFixtureAsLine('result-error'))
		expect(events).toHaveLength(1)
		const [event] = events
		if (event.kind !== 'result') throw new Error('unreachable')
		expect(event.subtype).toBe('error_max_turns')
		expect(event.isError).toBe(true)
		expect(event.text).toBeUndefined()
		expect(event.numTurns).toBe(10)
	})

	it('parses an explicit error envelope into an error event', () => {
		const events = parseChatLine(loadFixtureAsLine('error-envelope'))
		expect(events).toHaveLength(1)
		const [event] = events
		if (event.kind !== 'error') throw new Error('unreachable')
		expect(event.message).toBe("MCP server 'maskin' failed to initialize")
		expect(event.data.session_id).toBe('sess-chat-123')
	})

	it('returns a debug event for malformed JSON', () => {
		const raw = '{not valid json'
		expect(parseChatLine(raw)).toEqual([{ kind: 'debug', raw }])
	})

	it('returns a debug event for JSON that is not an object envelope', () => {
		const raw = '"just a string"'
		expect(parseChatLine(raw)).toEqual([{ kind: 'debug', raw }])
	})

	it('returns a debug event for an unknown envelope type', () => {
		const raw = JSON.stringify({ type: 'something_new', foo: 1 })
		expect(parseChatLine(raw)).toEqual([{ kind: 'debug', raw }])
	})

	it('returns a debug event for an assistant envelope without message.content', () => {
		const raw = JSON.stringify({ type: 'assistant', message: { id: 'x' } })
		expect(parseChatLine(raw)).toEqual([{ kind: 'debug', raw }])
	})

	it('returns no events for empty or whitespace-only lines', () => {
		expect(parseChatLine('')).toEqual([])
		expect(parseChatLine('   \t  ')).toEqual([])
	})
})

describe('parseChatStream', () => {
	it('parses a full transcript of newline-delimited envelopes end-to-end', () => {
		const transcript = [
			'system-init',
			'assistant-thinking',
			'assistant-tool-use',
			'user-tool-result',
			'assistant-text',
			'result-success',
		]
			.map(loadFixtureAsLine)
			.join('\n')

		const events = parseChatStream(transcript)
		expect(events.map((e) => e.kind)).toEqual(['system', 'thinking', 'tool_use', 'text', 'result'])
	})

	it('surfaces malformed interleaved lines as debug events without dropping neighbours', () => {
		const transcript = [
			loadFixtureAsLine('system-init'),
			'{not json',
			loadFixtureAsLine('assistant-text'),
		].join('\n')

		const events = parseChatStream(transcript)
		expect(events.map((e) => e.kind)).toEqual(['system', 'debug', 'text'])
	})

	it('tolerates CRLF line endings and skips blank lines', () => {
		const transcript = [
			loadFixtureAsLine('system-init'),
			'',
			loadFixtureAsLine('result-success'),
			'',
		].join('\r\n')

		const events = parseChatStream(transcript)
		expect(events.map((e) => e.kind)).toEqual(['system', 'result'])
	})
})
