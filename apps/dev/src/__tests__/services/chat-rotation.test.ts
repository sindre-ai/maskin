import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSessionContextSize, getSessionContextSize } from '../../lib/session-context-size'
import type { TurnSizeReading } from '../../lib/turn-size'
import {
	ChatRotation,
	type ChatRotationHost,
	HANDOFF_MARKER,
	type RotationRecord,
	buildHandoffPrompt,
	chatRotationEnabled,
	extractHandoffNote,
} from '../../services/chat-rotation'

const SESSION_ID = 'sess-1'

function session(overrides: Record<string, unknown> = {}) {
	return {
		id: SESSION_ID,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		status: 'running',
		interactive: true,
		conversationId: 'conv-1',
		modelName: 'deepseek/deepseek-v4.1-flash',
		config: {},
		...overrides,
	} as never
}

function reading(overrides: Partial<TurnSizeReading> = {}): TurnSizeReading {
	return {
		lastTurnWindowTokens: 160_000,
		contextWindowTokens: 1_000_000,
		compactionsInTurn: 0,
		isError: false,
		text: 'a reply',
		subtype: 'success',
		apiError: null,
		terminalReason: null,
		...overrides,
	}
}

function makeHost(overrides: Partial<ChatRotationHost> = {}) {
	const closed: RotationRecord[] = []
	const host: ChatRotationHost = {
		loadSession: vi.fn(async () => session()),
		writeHandoffTurn: vi.fn(async () => {}),
		hasUnansweredTurn: vi.fn(async () => false),
		closeForRotation: vi.fn(async (_s, record) => {
			closed.push(record)
		}),
		handoffTurnClosed: vi.fn(),
		...overrides,
	}
	return { host, closed }
}

const ON = { CHAT_ROTATION_ENABLED: 'true' } as NodeJS.ProcessEnv
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => forgetSessionContextSize(SESSION_ID))
afterEach(() => vi.useRealTimers())

describe('chatRotationEnabled', () => {
	it('is off unless the setting is on', () => {
		expect(chatRotationEnabled({} as NodeJS.ProcessEnv)).toBe(false)
		expect(chatRotationEnabled({ CHAT_ROTATION_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false)
		expect(chatRotationEnabled({ CHAT_ROTATION_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true)
		expect(chatRotationEnabled({ CHAT_ROTATION_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true)
	})
})

describe('handoff note', () => {
	it('asks for the four sections, standing rules in their own', () => {
		const prompt = buildHandoffPrompt()
		expect(prompt).toContain(HANDOFF_MARKER)
		for (const section of ['Goal:', 'Decisions:', 'Standing rules:', 'Open items:']) {
			expect(prompt).toContain(section)
		}
	})

	it('recognises a note by its first line and nothing else', () => {
		expect(extractHandoffNote('HANDOFF NOTE\nGoal: x')).toBe('HANDOFF NOTE\nGoal: x')
		expect(extractHandoffNote('## **Handoff note**\nGoal: x')).toContain('Goal: x')
		expect(extractHandoffNote('Sure, here is the plan you asked for.')).toBeNull()
		expect(extractHandoffNote('')).toBeNull()
	})
})

describe('ChatRotation.onTurn', () => {
	it('asks a chat session over the line for a handoff note', async () => {
		const { host } = makeHost()
		await new ChatRotation(host, { env: ON }).onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).toHaveBeenCalledWith(SESSION_ID)
	})

	it('does nothing under the line', async () => {
		const { host } = makeHost()
		await new ChatRotation(host, { env: ON }).onTurn(
			SESSION_ID,
			reading({ lastTurnWindowTokens: 100_000 }),
		)
		expect(host.writeHandoffTurn).not.toHaveBeenCalled()
	})

	it('records the size and still does nothing when the setting is off', async () => {
		const { host } = makeHost()
		await new ChatRotation(host, { env: {} as NodeJS.ProcessEnv }).onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).not.toHaveBeenCalled()
		expect(getSessionContextSize(SESSION_ID)).toMatchObject({
			lastTurnWindowTokens: 160_000,
			contextWindowTokens: 1_000_000,
		})
	})

	it('records a failed compaction as the end cause even with the setting off', async () => {
		const { host } = makeHost()
		await new ChatRotation(host, { env: {} as NodeJS.ProcessEnv }).onTurn(
			SESSION_ID,
			reading({ isError: true, text: 'Error: compaction failed', lastTurnWindowTokens: 300_000 }),
		)
		expect(getSessionContextSize(SESSION_ID)?.endCause).toBe('compaction_failed')
	})

	it('clears the end cause after a clean turn', async () => {
		const { host } = makeHost()
		const rotation = new ChatRotation(host, { env: {} as NodeJS.ProcessEnv })
		await rotation.onTurn(SESSION_ID, reading({ isError: true, text: 'Prompt is too long' }))
		expect(getSessionContextSize(SESSION_ID)?.endCause).toBe('context_full')
		await rotation.onTurn(SESSION_ID, reading({ lastTurnWindowTokens: 20_000 }))
		expect(getSessionContextSize(SESSION_ID)?.endCause).toBeUndefined()
	})

	it('rotates on a failed compaction whatever the size', async () => {
		const { host } = makeHost()
		await new ChatRotation(host, { env: ON }).onTurn(
			SESSION_ID,
			reading({ isError: true, text: 'Error: compaction failed', lastTurnWindowTokens: 30_000 }),
		)
		expect(host.writeHandoffTurn).toHaveBeenCalled()
	})

	it('leaves background sessions, helpers and idle rows alone', async () => {
		for (const row of [
			session({ conversationId: null }),
			session({ config: { stop_on_result: true } }),
			session({ status: 'completed' }),
			session({ interactive: false }),
		]) {
			const { host } = makeHost({ loadSession: vi.fn(async () => row) })
			await new ChatRotation(host, { env: ON }).onTurn(SESSION_ID, reading())
			expect(host.writeHandoffTurn).not.toHaveBeenCalled()
		}
	})

	it('waits for the next turn when a message is still unanswered', async () => {
		const { host } = makeHost({ hasUnansweredTurn: vi.fn(async () => true) })
		await new ChatRotation(host, { env: ON }).onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).not.toHaveBeenCalled()
	})

	it('asks once however many results arrive meanwhile', async () => {
		const { host } = makeHost()
		const rotation = new ChatRotation(host, { env: ON })
		await rotation.onTurn(SESSION_ID, reading())
		await rotation.onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).toHaveBeenCalledTimes(1)
	})

	it('keeps the session as it is when the handoff turn cannot be written', async () => {
		const { host } = makeHost({
			writeHandoffTurn: vi.fn(async () => Promise.reject(new Error('x'))),
		})
		const rotation = new ChatRotation(host, { env: ON })
		await rotation.onTurn(SESSION_ID, reading())
		expect(host.closeForRotation).not.toHaveBeenCalled()
		await rotation.onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).toHaveBeenCalledTimes(2)
	})
})

describe('ChatRotation handoff result', () => {
	const note = `${HANDOFF_MARKER}\nGoal: ship\nStanding rules: never email customers`

	it('keeps the note out of the chat and closes the session with it', async () => {
		const { host, closed } = makeHost()
		const rotation = new ChatRotation(host, { env: ON })
		await rotation.onTurn(SESSION_ID, reading())
		expect(rotation.claimHandoffResult(SESSION_ID, { text: note, isError: false })).toBe(true)
		await flush()
		expect(closed).toHaveLength(1)
		expect(closed[0]).toMatchObject({ reason: 'size', handoff: 'ok', sizeBucket: '150k_200k' })
		expect(closed[0]?.note).toContain('never email customers')
		expect(host.handoffTurnClosed).toHaveBeenCalledWith(SESSION_ID)
	})

	it('does not claim an ordinary result, or any result when none was asked for', async () => {
		const { host } = makeHost()
		const rotation = new ChatRotation(host, { env: ON })
		expect(rotation.claimHandoffResult(SESSION_ID, { text: note, isError: false })).toBe(false)
		await rotation.onTurn(SESSION_ID, reading())
		expect(
			rotation.claimHandoffResult(SESSION_ID, { text: 'A normal reply', isError: false }),
		).toBe(false)
		expect(rotation.claimHandoffResult(SESSION_ID, { text: note, isError: true })).toBe(false)
	})

	it('keeps the session when a message arrived while the note was written', async () => {
		const { host } = makeHost({
			hasUnansweredTurn: vi
				.fn()
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false),
		})
		const rotation = new ChatRotation(host, { env: ON })
		await rotation.onTurn(SESSION_ID, reading())
		rotation.claimHandoffResult(SESSION_ID, { text: note, isError: false })
		await flush()
		expect(host.closeForRotation).not.toHaveBeenCalled()
		// and asks again after the next turn
		await rotation.onTurn(SESSION_ID, reading())
		expect(host.writeHandoffTurn).toHaveBeenCalledTimes(2)
	})

	it('restarts without a note when the handoff turn never answers', async () => {
		vi.useFakeTimers()
		const { host, closed } = makeHost()
		const rotation = new ChatRotation(host, { env: ON, timeoutMs: 1_000 })
		await rotation.onTurn(SESSION_ID, reading())
		await vi.advanceTimersByTimeAsync(1_001)
		expect(closed).toHaveLength(1)
		expect(closed[0]).toMatchObject({ handoff: 'fallback', note: null })
	})

	it('records the compaction failure as the reason', async () => {
		const { host, closed } = makeHost()
		const rotation = new ChatRotation(host, { env: ON })
		await rotation.onTurn(
			SESSION_ID,
			reading({ isError: true, text: 'Error: compaction failed', lastTurnWindowTokens: null }),
		)
		rotation.claimHandoffResult(SESSION_ID, { text: note, isError: false })
		await flush()
		expect(closed[0]).toMatchObject({ reason: 'compaction_failed', sizeBucket: 'unknown' })
		// The handoff turn is clean, and must not wipe the cause the rotation started from.
		await rotation.onTurn(SESSION_ID, reading({ lastTurnWindowTokens: 20_000 }))
		expect(getSessionContextSize(SESSION_ID)?.endCause).toBe('compaction_failed')
	})

	it('forgets a session that goes away', async () => {
		vi.useFakeTimers()
		const { host } = makeHost()
		const rotation = new ChatRotation(host, { env: ON, timeoutMs: 1_000 })
		await rotation.onTurn(SESSION_ID, reading())
		rotation.forget(SESSION_ID)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(host.closeForRotation).not.toHaveBeenCalled()
	})
})
