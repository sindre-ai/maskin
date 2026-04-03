import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { PgEvent, PgNotifyBridge } from '../notify'
import { createSSEHandler } from '../sse'

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

function createTestSetup() {
	const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
	const app = new Hono()
	app.get('/events', createSSEHandler(bridge))
	return { bridge, app }
}

function parseSSEEvents(text: string): Array<{ id?: string; event?: string; data?: string }> {
	return text
		.split('\n\n')
		.filter((block) => block.trim())
		.map((block) => {
			const parsed: Record<string, string> = {}
			for (const line of block.split('\n')) {
				const colonIndex = line.indexOf(':')
				if (colonIndex > 0) {
					const key = line.slice(0, colonIndex).trim()
					const value = line.slice(colonIndex + 1).trim()
					parsed[key] = value
				}
			}
			return parsed
		})
}

/**
 * Helper to read SSE chunks from the stream without waiting for it to close.
 * Emits events on the bridge, reads available chunks, then aborts.
 */
async function collectSSEEvents(
	app: Hono,
	path: string,
	bridge: EventEmitter,
	emitEvents: PgEvent[],
): Promise<{ res: Response; text: string; events: ReturnType<typeof parseSSEEvents> }> {
	const res = await app.request(path)

	// Wait for the listener to be registered on the bridge
	await new Promise<void>((resolve) => {
		const check = () => {
			if (bridge.listenerCount('event') > 0) resolve()
			else setTimeout(check, 5)
		}
		check()
	})

	for (const event of emitEvents) {
		bridge.emit('event', event)
	}

	// Give stream time to write
	await new Promise((r) => setTimeout(r, 50))

	// Read whatever chunks are available from the stream
	const body = res.body
	if (!body) return { res, text: '', events: [] }

	const reader = body.getReader()
	const decoder = new TextDecoder()
	let text = ''

	// Read available chunks with a timeout
	const readChunks = async () => {
		while (true) {
			const readPromise = reader.read()
			const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
				setTimeout(() => resolve({ done: true, value: undefined }), 100),
			)
			const { done, value } = await Promise.race([readPromise, timeoutPromise])
			if (done) break
			if (value) text += decoder.decode(value, { stream: true })
		}
	}

	await readChunks()
	reader.cancel()

	return { res, text, events: parseSSEEvents(text) }
}

describe('createSSEHandler', () => {
	it('returns a response with SSE content type', async () => {
		const { app } = createTestSetup()
		const res = await app.request('/events')

		expect(res.headers.get('content-type')).toContain('text/event-stream')

		// Clean up: cancel the stream
		res.body?.cancel()
	})

	it('writes SSE events matching the workspace_id filter', async () => {
		const { app, bridge } = createTestSetup()
		const event = buildPgEvent({ workspace_id: 'ws-1' })

		const { events } = await collectSSEEvents(app, '/events?workspace_id=ws-1', bridge, [event])

		expect(events.length).toBeGreaterThanOrEqual(1)
		const sseEvent = events.find((e) => e.id === 'evt-test-001')
		expect(sseEvent).toBeDefined()
		expect(sseEvent?.event).toBe('object.created')
	})

	it('filters out events for different workspace_id', async () => {
		const { app, bridge } = createTestSetup()
		const wrongEvent = buildPgEvent({ workspace_id: 'ws-other', event_id: 'evt-wrong' })
		const rightEvent = buildPgEvent({ workspace_id: 'ws-1', event_id: 'evt-right' })

		const { events } = await collectSSEEvents(app, '/events?workspace_id=ws-1', bridge, [
			wrongEvent,
			rightEvent,
		])

		expect(events.find((e) => e.id === 'evt-wrong')).toBeUndefined()
		expect(events.find((e) => e.id === 'evt-right')).toBeDefined()
	})

	it('passes through all events when no workspace_id query param is set', async () => {
		const { app, bridge } = createTestSetup()
		const event1 = buildPgEvent({ workspace_id: 'ws-1', event_id: 'evt-1' })
		const event2 = buildPgEvent({ workspace_id: 'ws-2', event_id: 'evt-2' })

		const { events } = await collectSSEEvents(app, '/events', bridge, [event1, event2])

		expect(events.find((e) => e.id === 'evt-1')).toBeDefined()
		expect(events.find((e) => e.id === 'evt-2')).toBeDefined()
	})

	it('formats SSE events with correct id, event, and data fields', async () => {
		const { app, bridge } = createTestSetup()
		const pgEvent = buildPgEvent({
			event_id: 'evt-format',
			action: 'object.updated',
			data: { changed: true },
		})

		const { events } = await collectSSEEvents(app, '/events', bridge, [pgEvent])

		const sseEvent = events.find((e) => e.id === 'evt-format')
		expect(sseEvent).toBeDefined()
		expect(sseEvent?.event).toBe('object.updated')
		expect(JSON.parse(sseEvent?.data ?? '')).toEqual(pgEvent)
	})

	it('removes the event listener from bridge on abort', async () => {
		const { app, bridge } = createTestSetup()
		const res = await app.request('/events')

		// Wait for listener to register
		await new Promise<void>((resolve) => {
			const check = () => {
				if (bridge.listenerCount('event') > 0) resolve()
				else setTimeout(check, 5)
			}
			check()
		})

		expect(bridge.listenerCount('event')).toBe(1)

		// Cancel the stream (simulates client disconnect)
		await res.body?.cancel()

		// Give a tick for the abort handler to run
		await new Promise((r) => setTimeout(r, 50))
		expect(bridge.listenerCount('event')).toBe(0)
	})

	it('handles multiple concurrent SSE connections independently', async () => {
		const { app, bridge } = createTestSetup()

		const res1 = await app.request('/events?workspace_id=ws-1')
		const res2 = await app.request('/events?workspace_id=ws-2')

		// Wait for both listeners
		await new Promise<void>((resolve) => {
			const check = () => {
				if (bridge.listenerCount('event') >= 2) resolve()
				else setTimeout(check, 5)
			}
			check()
		})

		bridge.emit('event', buildPgEvent({ workspace_id: 'ws-1', event_id: 'evt-for-1' }))
		bridge.emit('event', buildPgEvent({ workspace_id: 'ws-2', event_id: 'evt-for-2' }))

		await new Promise((r) => setTimeout(r, 50))

		// Read chunks from both streams
		const readStream = async (res: Response) => {
			const body = res.body
			if (!body) return ''
			const reader = body.getReader()
			const decoder = new TextDecoder()
			let text = ''
			while (true) {
				const readPromise = reader.read()
				const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), 100),
				)
				const { done, value } = await Promise.race([readPromise, timeout])
				if (done) break
				if (value) text += decoder.decode(value, { stream: true })
			}
			reader.cancel()
			return text
		}

		const [text1, text2] = await Promise.all([readStream(res1), readStream(res2)])
		const events1 = parseSSEEvents(text1)
		const events2 = parseSSEEvents(text2)

		expect(events1.find((e) => e.id === 'evt-for-1')).toBeDefined()
		expect(events1.find((e) => e.id === 'evt-for-2')).toBeUndefined()
		expect(events2.find((e) => e.id === 'evt-for-2')).toBeDefined()
		expect(events2.find((e) => e.id === 'evt-for-1')).toBeUndefined()
	})

	it('handles events with null data field', async () => {
		const { app, bridge } = createTestSetup()
		const pgEvent = buildPgEvent({ data: null, event_id: 'evt-null-data' })

		const { events } = await collectSSEEvents(app, '/events', bridge, [pgEvent])

		const sseEvent = events.find((e) => e.id === 'evt-null-data')
		expect(sseEvent).toBeDefined()
		const parsed = JSON.parse(sseEvent?.data ?? '')
		expect(parsed.data).toBeNull()
	})
})
