import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PgEvent } from '../notify'

let listenCallback: ((payload: string) => void) | null = null

const mockSql = {
	listen: vi.fn(async (_channel: string, cb: (payload: string) => void) => {
		listenCallback = cb
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
		data: null,
		...overrides,
	}
}

describe('PgNotifyBridge', () => {
	beforeEach(() => {
		listenCallback = null
		vi.clearAllMocks()
	})

	it('creates a postgres connection with max 1', () => {
		new PgNotifyBridge('postgres://localhost/test')
		expect(mockPostgres).toHaveBeenCalledWith('postgres://localhost/test', { max: 1 })
	})

	it('listens on the events channel when start is called', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()
		expect(mockSql.listen).toHaveBeenCalledWith('events', expect.any(Function))
	})

	it('emits an event when a valid JSON payload arrives', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		const event = buildPgEvent()
		listenCallback?.(JSON.stringify(event))

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(event)
	})

	it('emits event with correct data field when data is present', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		const event = buildPgEvent({ data: { key: 'value', nested: { a: 1 } } })
		listenCallback?.(JSON.stringify(event))

		expect(handler.mock.calls[0]?.[0].data).toEqual({ key: 'value', nested: { a: 1 } })
	})

	it('silently ignores malformed JSON payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		expect(() => listenCallback?.('not-valid-json{{')).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('silently ignores empty string payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		expect(() => listenCallback?.('')).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('emits multiple events for multiple payloads', async () => {
		const bridge = new PgNotifyBridge('postgres://localhost/test')
		await bridge.start()

		const handler = vi.fn()
		bridge.on('event', handler)

		const event1 = buildPgEvent({ event_id: 'evt-1' })
		const event2 = buildPgEvent({ event_id: 'evt-2' })
		listenCallback?.(JSON.stringify(event1))
		listenCallback?.(JSON.stringify(event2))

		expect(handler).toHaveBeenCalledTimes(2)
		expect(handler.mock.calls[0]?.[0].event_id).toBe('evt-1')
		expect(handler.mock.calls[1]?.[0].event_id).toBe('evt-2')
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
		expect(mockSql.listen).toHaveBeenCalledOnce()
		expect(mockSql.end).toHaveBeenCalledOnce()
	})
})
