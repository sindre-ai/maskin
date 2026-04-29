import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type MaskinEvent,
	createSubscriptionRegistry,
	matchesFilter,
	parseSSEChunk,
} from '../subscriptions'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: 'ws-default',
}

function buildEvent(overrides: Partial<MaskinEvent> = {}): MaskinEvent {
	return {
		workspace_id: 'ws-1',
		actor_id: 'actor-1',
		action: 'created',
		entity_type: 'task',
		entity_id: 'obj-1',
		event_id: '1',
		...overrides,
	}
}

function buildSSEFrame(data: Record<string, unknown>, opts: { id?: string; event?: string } = {}) {
	const lines: string[] = []
	if (opts.id) lines.push(`id: ${opts.id}`)
	if (opts.event) lines.push(`event: ${opts.event}`)
	lines.push(`data: ${JSON.stringify(data)}`)
	return `${lines.join('\n')}\n\n`
}

function makeMockServer() {
	const sendLoggingMessage = vi.fn().mockResolvedValue(undefined)
	return {
		server: { sendLoggingMessage },
		_send: sendLoggingMessage,
	} as unknown as {
		server: { sendLoggingMessage: ReturnType<typeof vi.fn> }
		_send: ReturnType<typeof vi.fn>
	}
}

// Build an SSE Response. If `keepOpen` is true (default), the stream emits the
// chunks and then hangs — this models a long-lived SSE connection, so the
// stream reader won't reach `done: true` and trigger a reconnect under test.
// Pass `keepOpen: false` to close the stream after emitting (useful for
// testing reconnect behavior).
function makeSSEResponse(chunks: string[], opts: { keepOpen?: boolean } = {}): Response {
	const keepOpen = opts.keepOpen ?? true
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			if (!keepOpen) controller.close()
		},
	})
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

function makeHangingSSEResponse(): { response: Response } {
	return { response: makeSSEResponse([], { keepOpen: true }) }
}

// A mock fetch impl that returns a never-resolving promise, but rejects when
// the request's AbortSignal fires. Lets tests verify connect-time behavior
// (headers, dedup, etc.) without the run loop ever actually reading a body.
function makeHangingFetch(): ReturnType<typeof vi.fn> {
	return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
		return new Promise((_resolve, reject) => {
			const signal = init?.signal
			if (signal?.aborted) {
				reject(new DOMException('aborted', 'AbortError'))
				return
			}
			signal?.addEventListener('abort', () => {
				reject(new DOMException('aborted', 'AbortError'))
			})
		})
	})
}

describe('matchesFilter', () => {
	it('matches everything with empty filter', () => {
		expect(matchesFilter(buildEvent(), {})).toBe(true)
	})

	it('matches single field', () => {
		const e = buildEvent({ entity_type: 'task' })
		expect(matchesFilter(e, { entity_type: ['task'] })).toBe(true)
		expect(matchesFilter(e, { entity_type: ['bet'] })).toBe(false)
	})

	it('OR within a field', () => {
		const e = buildEvent({ action: 'created' })
		expect(matchesFilter(e, { action: ['created', 'updated'] })).toBe(true)
	})

	it('AND across fields', () => {
		const e = buildEvent({ entity_type: 'task', action: 'created' })
		expect(matchesFilter(e, { entity_type: ['task'], action: ['created'] })).toBe(true)
		expect(matchesFilter(e, { entity_type: ['task'], action: ['updated'] })).toBe(false)
	})

	it('matches on actor_id', () => {
		const e = buildEvent({ actor_id: 'actor-1' })
		expect(matchesFilter(e, { actor_id: ['actor-1'] })).toBe(true)
		expect(matchesFilter(e, { actor_id: ['actor-2'] })).toBe(false)
	})

	it('empty filter arrays are treated as "no filter on that field"', () => {
		const e = buildEvent({ entity_type: 'task' })
		expect(matchesFilter(e, { entity_type: [] })).toBe(true)
	})
})

describe('parseSSEChunk', () => {
	it('returns no frames for empty buffer', () => {
		expect(parseSSEChunk('')).toEqual({ frames: [], residual: '' })
	})

	it('parses one complete frame', () => {
		const { frames, residual } = parseSSEChunk('id: 1\nevent: created\ndata: {"a":1}\n\n')
		expect(frames).toHaveLength(1)
		expect(frames[0]).toEqual({ id: '1', event: 'created', data: '{"a":1}' })
		expect(residual).toBe('')
	})

	it('preserves residual for incomplete frame', () => {
		const { frames, residual } = parseSSEChunk('id: 1\ndata: {"a":1}\n\nid: 2\ndata: parti')
		expect(frames).toHaveLength(1)
		expect(residual).toBe('id: 2\ndata: parti')
	})

	it('ignores comments and blank lines', () => {
		const { frames } = parseSSEChunk(':heartbeat\n\nid: 1\ndata: {"x":1}\n\n')
		expect(frames).toHaveLength(1)
		expect(frames[0].data).toBe('{"x":1}')
	})

	it('concatenates multi-line data fields with \\n', () => {
		const { frames } = parseSSEChunk('data: line1\ndata: line2\n\n')
		expect(frames[0].data).toBe('line1\nline2')
	})

	it('normalizes \\r\\n to \\n', () => {
		const { frames } = parseSSEChunk('id: 1\r\ndata: {"a":1}\r\n\r\n')
		expect(frames).toHaveLength(1)
		expect(frames[0].data).toBe('{"a":1}')
	})

	it('handles missing space after colon', () => {
		const { frames } = parseSSEChunk('id:1\ndata:{"a":1}\n\n')
		expect(frames[0]).toEqual({ id: '1', data: '{"a":1}' })
	})
})

describe('SubscriptionRegistry lifecycle', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('add assigns a uuid and returns the subscription', () => {
		const mock = makeMockServer()
		// Block fetch so the stream doesn't actually run
		vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', { entity_type: ['task'] })
		expect(sub.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(sub.workspaceId).toBe('ws-1')
		expect(sub.filter).toEqual({ entity_type: ['task'] })
		expect(sub.eventsDelivered).toBe(0)
	})

	it('reuses a single stream per workspace across multiple subscriptions', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-shared', {})
		registry.add('ws-shared', {})
		// Allow microtasks to flush (run() is async)
		await Promise.resolve()
		await Promise.resolve()
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(registry.list()).toHaveLength(2)
		await registry.shutdownAll()
	})

	it('opens separate streams for different workspaces', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-a', {})
		registry.add('ws-b', {})
		await Promise.resolve()
		await Promise.resolve()
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		await registry.shutdownAll()
	})

	it('remove returns true for an existing subscription and false otherwise', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', {})
		expect(registry.remove(sub.id)).toBe(true)
		expect(registry.remove(sub.id)).toBe(false)
		expect(registry.remove('00000000-0000-0000-0000-000000000000')).toBe(false)
		await registry.shutdownAll()
	})

	it('sets X-Workspace-Id and Authorization headers on the SSE request', async () => {
		const mock = makeMockServer()
		const hanging = makeHangingSSEResponse()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(hanging.response)
		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-abc', {})
		await Promise.resolve()
		await Promise.resolve()
		const call = fetchSpy.mock.calls[0]
		expect(call[0]).toBe('http://localhost:3000/api/events')
		const init = call[1] as RequestInit
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ank_testkey')
		expect(headers['X-Workspace-Id']).toBe('ws-abc')
		expect(headers.Accept).toBe('text/event-stream')
		await registry.shutdownAll()
	})
})

describe('event delivery', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('delivers matching events via sendLoggingMessage and increments counters', async () => {
		const mock = makeMockServer()
		const chunks = [
			buildSSEFrame(
				{
					workspace_id: 'ws-1',
					actor_id: 'actor-1',
					action: 'created',
					entity_type: 'task',
					entity_id: 'obj-1',
					event_id: '10',
				},
				{ id: '10', event: 'created' },
			),
			buildSSEFrame(
				{
					workspace_id: 'ws-1',
					actor_id: 'actor-2',
					action: 'created',
					entity_type: 'bet',
					entity_id: 'obj-2',
					event_id: '11',
				},
				{ id: '11', event: 'created' },
			),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks))

		const registry = createSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', { entity_type: ['task'] })

		// Wait long enough for the stream reader to drain the canned chunks.
		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).toHaveBeenCalledTimes(1)
		const call = mock._send.mock.calls[0][0]
		expect(call.level).toBe('info')
		expect(call.logger).toBe('maskin/events')
		expect(call.data.subscription_id).toBe(sub.id)
		expect(call.data.event.entity_type).toBe('task')
		expect(call.data.event.event_id).toBe('10')

		const [stored] = registry.list()
		expect(stored.eventsDelivered).toBe(1)
		expect(stored.eventsDropped).toBe(0)

		await registry.shutdownAll()
	})

	it('normalizes camelCase replayed events to snake_case and strips `data`', async () => {
		const mock = makeMockServer()
		const chunks = [
			buildSSEFrame(
				{
					id: 5,
					workspaceId: 'ws-1',
					actorId: 'actor-1',
					action: 'updated',
					entityType: 'bet',
					entityId: 'obj-9',
					data: { title: 'should be stripped' },
				},
				{ id: '5' },
			),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks))

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).toHaveBeenCalledTimes(1)
		const event = mock._send.mock.calls[0][0].data.event
		expect(event.entity_type).toBe('bet')
		expect(event.entity_id).toBe('obj-9')
		expect(event.event_id).toBe('5')
		expect('data' in event).toBe(false)

		await registry.shutdownAll()
	})

	it('increments eventsDropped when sendLoggingMessage throws', async () => {
		const mock = makeMockServer()
		mock._send.mockRejectedValue(new Error('client disconnected'))
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			makeSSEResponse([
				buildSSEFrame(
					{
						workspace_id: 'ws-1',
						actor_id: 'actor-1',
						action: 'created',
						entity_type: 'task',
						entity_id: 'obj-1',
						event_id: '1',
					},
					{ id: '1' },
				),
			]),
		)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 20))

		const [stored] = registry.list()
		expect(stored.eventsDelivered).toBe(0)
		expect(stored.eventsDropped).toBe(1)
		errorSpy.mockRestore()
		await registry.shutdownAll()
	})

	it('dedupes events with identical event_id', async () => {
		const mock = makeMockServer()
		const frame = buildSSEFrame(
			{
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				action: 'created',
				entity_type: 'task',
				entity_id: 'obj-1',
				event_id: '42',
			},
			{ id: '42' },
		)
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse([frame, frame]))

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).toHaveBeenCalledTimes(1)
		await registry.shutdownAll()
	})

	it('filters out non-matching events', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			makeSSEResponse([
				buildSSEFrame(
					{
						workspace_id: 'ws-1',
						actor_id: 'actor-1',
						action: 'created',
						entity_type: 'task',
						entity_id: 'obj-1',
						event_id: '1',
					},
					{ id: '1' },
				),
			]),
		)

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', { entity_type: ['bet'] })

		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).not.toHaveBeenCalled()
		await registry.shutdownAll()
	})
})

describe('reconnection', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('sends Last-Event-ID on reconnect after delivering events', async () => {
		const mock = makeMockServer()
		const chunk = buildSSEFrame(
			{
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				action: 'created',
				entity_type: 'task',
				entity_id: 'obj-1',
				event_id: '100',
			},
			{ id: '100' },
		)
		// First response: delivers one event then CLOSES, triggering reconnect. Second response: hangs forever.
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(makeSSEResponse([chunk], { keepOpen: false }))
			.mockResolvedValueOnce(makeHangingSSEResponse().response)

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		// First connect drains + closes, then a 1s backoff, then reconnect.
		await new Promise((r) => setTimeout(r, 1200))

		expect(fetchSpy).toHaveBeenCalledTimes(2)
		const secondHeaders = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<
			string,
			string
		>
		expect(secondHeaders['Last-Event-ID']).toBe('100')

		await registry.shutdownAll()
	}, 3000)

	it('tears down subscriptions on a 401 auth error', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 50))

		expect(registry.list()).toHaveLength(0)
		// The warn logging notification should have been sent
		const warnCall = mock._send.mock.calls.find((c) => c[0].level === 'error')
		expect(warnCall).toBeDefined()

		errorSpy.mockRestore()
		await registry.shutdownAll()
	})

	it('tears down subscriptions on a 404 (wrong endpoint)', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 50))

		expect(registry.list()).toHaveLength(0)
		const errorCall = mock._send.mock.calls.find((c) => c[0].level === 'error')
		expect(errorCall?.[0].data.message).toContain('404')

		errorSpy.mockRestore()
		await registry.shutdownAll()
	})

	it('does NOT tear down on a 429 (rate limit) — retries with backoff', async () => {
		const mock = makeMockServer()
		const hanging = makeHangingSSEResponse().response
		// First response: 429. Second response: hangs (successful reconnect).
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
			.mockResolvedValue(hanging)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', {})

		// First connect fails with 429, waits 1s backoff, reconnects successfully.
		await new Promise((r) => setTimeout(r, 1200))

		expect(registry.list()).toHaveLength(1)
		// No error-level logging notification — 429 is transient, not terminal.
		const errorCall = mock._send.mock.calls.find((c) => c[0].level === 'error')
		expect(errorCall).toBeUndefined()

		errorSpy.mockRestore()
		await registry.shutdownAll()
	}, 3000)

	it('cleans up registry state after terminal teardown — fresh add opens a new stream', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			// First add: terminal 401.
			.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
			// Second add: hangs.
			.mockResolvedValue(makeHangingSSEResponse().response)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSubscriptionRegistry(config, mock as never)
		const stale = registry.add('ws-1', {})

		await new Promise((r) => setTimeout(r, 50))

		expect(registry.list()).toHaveLength(0)
		// The stale subscription id should be fully forgotten (no stream to remove from).
		expect(registry.remove(stale.id)).toBe(false)

		// A new add on the same workspace should open a fresh fetch.
		const callsBefore = fetchSpy.mock.calls.length
		registry.add('ws-1', {})
		await Promise.resolve()
		await Promise.resolve()
		expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore)
		expect(registry.list()).toHaveLength(1)

		errorSpy.mockRestore()
		await registry.shutdownAll()
	})
})
