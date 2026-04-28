import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgEvent, PgSessionLogEvent } from '../notify'

const listenCallbacks = new Map<string, (payload: string) => void>()

const mockSql = {
	listen: vi.fn(async (channel: string, cb: (payload: string) => void) => {
		listenCallbacks.set(channel, cb)
	}),
	end: vi.fn(async () => {}),
}

const mockPostgres = vi.fn(() => mockSql)

vi.mock('postgres', () => ({
	default: mockPostgres,
}))

// Import after mock setup
const { PgNotifyBridge } = await import('../notify')

function buildPgEvent(overrides: Partial<PgEvent> = {}): PgEvent {
	return {
		workspace_id: 'ws-test-001',
		actor_id: 'actor-test-001',
		action: 'object.created',
		entity_type: 'object',
		entity_id: 'obj-test-001',
		event_id: 'evt-test-001',
		...overrides,
	}
}

function buildPgSessionLogEvent(overrides: Partial<PgSessionLogEvent> = {}): PgSessionLogEvent {
	return {
		id: 1,
		session_id: 'session-test-001',
		stream: 'stdout',
		content: 'test log output',
		...overrides,
	}
}

describe('PgNotifyBridge', () => {
	beforeEach(() => {
		listenCallbacks.clear()
		vi.clearAllMocks()
	})

	it('creates a postgres connection with max 1', () => {
		new PgNotifyBridge('postgres://localhost/test')
		expect(mockPostgres).toHaveBeenCalledWith('postgres://localhost/test', { max: 1 })
	})

	it('listens on both events and session_logs channels when started', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()
		expect(mockSql.listen).toHaveBeenCalledWith('events', expect.any(Function))
		expect(mockSql.listen).toHaveBeenCalledWith('session_logs', expect.any(Function))
	})

	it('emits an event when a valid JSON payload arrives on events channel', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		const event = buildPgEvent()
		listenCallbacks.get('events')?.(JSON.stringify(event))

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(event)
	})

	it('emits a session_log event when a valid payload arrives on session_logs channel', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('session_log', handler)

		const log = buildPgSessionLogEvent()
		listenCallbacks.get('session_logs')?.(JSON.stringify(log))

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(log)
	})

	it('silently ignores malformed JSON payloads on events channel', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		expect(() => listenCallbacks.get('events')?.('not-valid-json{{')).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('silently ignores malformed JSON payloads on session_logs channel', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('session_log', handler)

		expect(() => listenCallbacks.get('session_logs')?.('not-valid-json{{')).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('silently ignores empty string payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		expect(() => listenCallbacks.get('events')?.('')).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('emits multiple events for multiple payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		const event1 = buildPgEvent({ event_id: 'evt-1' })
		const event2 = buildPgEvent({ event_id: 'evt-2' })
		listenCallbacks.get('events')?.(JSON.stringify(event1))
		listenCallbacks.get('events')?.(JSON.stringify(event2))

		expect(handler).toHaveBeenCalledTimes(2)
		expect(handler.mock.calls[0]?.[0].event_id).toBe('evt-1')
		expect(handler.mock.calls[1]?.[0].event_id).toBe('evt-2')
	})

	it('emits multiple session_log events for multiple payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('session_log', handler)

		const log1 = buildPgSessionLogEvent({ id: 1, content: 'line 1' })
		const log2 = buildPgSessionLogEvent({ id: 2, content: 'line 2' })
		listenCallbacks.get('session_logs')?.(JSON.stringify(log1))
		listenCallbacks.get('session_logs')?.(JSON.stringify(log2))

		expect(handler).toHaveBeenCalledTimes(2)
		expect(handler.mock.calls[0]?.[0].content).toBe('line 1')
		expect(handler.mock.calls[1]?.[0].content).toBe('line 2')
	})

	it('ends the postgres connection when stop is called', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.stop()
		expect(mockSql.end).toHaveBeenCalledOnce()
	})

	it('can be started and stopped without errors', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()
		await bridge.stop()
		expect(mockSql.listen).toHaveBeenCalledTimes(2)
		expect(mockSql.end).toHaveBeenCalledOnce()
	})
})
