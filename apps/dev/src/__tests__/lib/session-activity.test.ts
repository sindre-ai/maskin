import { MAX_STEPS_PER_TURN, buildSessionActivity } from '../../lib/session-activity'

let nextId = 1
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n))
const row = (stream: string, content: unknown, sec = nextId) => ({
	id: nextId++,
	stream,
	content: typeof content === 'string' ? content : JSON.stringify(content),
	createdAt: at(sec),
})
const userTurn = (messageId: number) =>
	row('stdout', { type: 'user', message: { content: 'hi' }, maskin_message_id: messageId })
const assistant = (...content: unknown[]) =>
	row('stdout', { type: 'assistant', message: { content } })

describe('buildSessionActivity', () => {
	beforeEach(() => {
		nextId = 1
	})

	it('splits steps per tagged turn and closes tools on tool_result', () => {
		const rows = [
			userTurn(10),
			assistant(
				{ type: 'thinking', thinking: 'hmm' },
				{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } },
			),
			row('stdout', {
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
			}),
			row('stdout', { type: 'result', is_error: false, result: 'Done.' }),
			userTurn(11),
			assistant({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }),
		]
		const turns = buildSessionActivity(rows)
		expect(turns.map((t) => t.message_id)).toEqual([10, 11])
		expect(turns[0]?.status).toBe('completed')
		expect(turns[0]?.result?.text).toBe('Done.')
		const tool = turns[0]?.steps.find((s) => s.kind === 'tool_use')
		expect(tool).toMatchObject({ label: 'Using Read', detail: '/a/b.ts', status: 'completed' })
		expect(tool?.finished_at).not.toBeNull()
		expect(turns[1]?.status).toBe('running')
		expect(turns[1]?.steps[0]).toMatchObject({ status: 'running', finished_at: null })
	})

	it('marks failed tool results, error results and stderr', () => {
		const rows = [
			userTurn(1),
			assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
			row('stdout', {
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
			}),
			row('stderr', 'boom'),
			row('stdout', { type: 'result', is_error: true, result: 'API error' }),
		]
		const [turn] = buildSessionActivity(rows)
		expect(turn?.status).toBe('failed')
		expect(turn?.steps.map((s) => [s.kind, s.status])).toEqual([
			['tool_use', 'failed'],
			['error', 'failed'],
		])
	})

	it('collapses the reply tool and drops restating text', () => {
		const rows = [
			userTurn(1),
			assistant({ type: 'tool_use', id: 't', name: 'mcp__maskin__post_conversation_message' }),
			assistant({ type: 'text', text: 'I replied.' }),
		]
		const [turn] = buildSessionActivity(rows)
		expect(turn?.contains_reply).toBe(true)
		expect(turn?.steps).toHaveLength(1)
		expect(turn?.steps[0]?.label).toBe('Replied to the conversation.')
	})

	it('reopens the turn on a retry envelope', () => {
		const rows = [
			userTurn(1),
			row('stdout', { type: 'result', is_error: true, result: 'overloaded' }),
			row('stdout', { type: 'user', message: { content: 'again' }, maskin_retry: true }),
		]
		const [turn] = buildSessionActivity(rows)
		expect(turn?.status).toBe('running')
		expect(turn?.result).toBeNull()
	})

	it('ignores untagged leading steps, system rows and invalid JSON', () => {
		const rows = [
			assistant({ type: 'text', text: 'orphan' }),
			row('system', 'boot'),
			row('stdout', 'not json'),
			userTurn(5),
		]
		const turns = buildSessionActivity(rows)
		expect(turns).toHaveLength(1)
		expect(turns[0]?.steps).toEqual([])
	})

	it('caps steps per turn keeping the newest', () => {
		const rows = [
			userTurn(1),
			...Array.from({ length: MAX_STEPS_PER_TURN + 5 }, () =>
				assistant({ type: 'thinking', thinking: 'x' }),
			),
		]
		const [turn] = buildSessionActivity(rows)
		expect(turn?.steps).toHaveLength(MAX_STEPS_PER_TURN)
		expect(turn?.steps_truncated).toBe(true)
		expect(turn?.steps.at(-1)?.id).toBe(`${rows.at(-1)?.id}-0`)
	})
})
