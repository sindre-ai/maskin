import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type ParsedSSEFrame,
	createManagedSSE,
	isTerminalStatus,
	parseSSEChunk,
} from '../lib/managed-sse'
import { buildSSEFrame, makeHangingSSEResponse, makeSSEResponse } from './sse-test-utils'

describe('isTerminalStatus', () => {
	it('treats 4xx as terminal except 408 and 429', () => {
		expect(isTerminalStatus(400)).toBe(true)
		expect(isTerminalStatus(401)).toBe(true)
		expect(isTerminalStatus(403)).toBe(true)
		expect(isTerminalStatus(404)).toBe(true)
		expect(isTerminalStatus(408)).toBe(false)
		expect(isTerminalStatus(429)).toBe(false)
		expect(isTerminalStatus(500)).toBe(false)
		expect(isTerminalStatus(502)).toBe(false)
		expect(isTerminalStatus(200)).toBe(false)
	})
})

describe('parseSSEChunk (managed-sse)', () => {
	it('ignores `: keepalive` heartbeat comments', () => {
		const { frames } = parseSSEChunk(': keepalive\n\nid: 1\ndata: x\n\n')
		expect(frames).toHaveLength(1)
		expect(frames[0].data).toBe('x')
	})
})

describe('createManagedSSE — terminal frame', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('invokes onTerminal when parseFrame returns { terminal: true }', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			makeSSEResponse([buildSSEFrame('completed', { event: 'done' })], { keepOpen: false }),
		)
		const onTerminal = vi.fn()
		const onItem = vi.fn().mockResolvedValue(undefined)
		const onWarn = vi.fn().mockResolvedValue(undefined)

		const stream = createManagedSSE<{ status: string }>({
			url: 'http://test/stream',
			headers: () => ({ Authorization: 'Bearer t' }),
			parseFrame: (frame: ParsedSSEFrame) => {
				if (frame.event === 'done') {
					return { item: { status: frame.data ?? '' }, terminal: true }
				}
				return null
			},
			onItem,
			onWarn,
			onTerminal,
			replayCap: 100,
			logTag: 'test',
		})

		stream.addRef('sub-1')
		await new Promise((r) => setTimeout(r, 30))

		expect(onItem).toHaveBeenCalledTimes(1)
		expect(onItem.mock.calls[0][0]).toEqual({ status: 'completed' })
		expect(onTerminal).toHaveBeenCalledTimes(1)
		expect(onTerminal).toHaveBeenCalledWith('stream_end')

		await stream.stop()
	})
})

describe('createManagedSSE — gap detection', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// When reconnecting with Last-Event-ID, if the backend replays exactly
	// `replayCap` frames, the warning fires exactly once per connect.
	it('fires a single gap warning when replayCap is hit on a resumed connect', async () => {
		// First connect: deliver one event then close. Sets lastEventId, triggers reconnect.
		// Second connect (resume): deliver replayCap=3 frames → should warn once.
		const firstFrame = buildSSEFrame({ n: 1 }, { id: '1' })
		const replayFrames = [
			buildSSEFrame({ n: 2 }, { id: '2' }),
			buildSSEFrame({ n: 3 }, { id: '3' }),
			buildSSEFrame({ n: 4 }, { id: '4' }),
		]
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(makeSSEResponse([firstFrame], { keepOpen: false }))
			// After the cap is hit we need the stream to stay open so more
			// processing doesn't trigger another reconnect.
			.mockResolvedValueOnce(makeSSEResponse(replayFrames, { keepOpen: true }))

		const onWarn = vi.fn().mockResolvedValue(undefined)
		const onItem = vi.fn().mockResolvedValue(undefined)
		const onTerminal = vi.fn()

		const stream = createManagedSSE<{ n: number }>({
			url: 'http://test/stream',
			headers: () => ({ Authorization: 'Bearer t' }),
			parseFrame: (frame) => {
				if (!frame.data) return null
				return { item: JSON.parse(frame.data) as { n: number } }
			},
			onItem,
			onWarn,
			onTerminal,
			replayCap: 3,
			logTag: 'gap-test',
		})

		stream.addRef('sub-1')
		// First connect drains + closes, 1s backoff, reconnect, deliver 3 frames.
		await new Promise((r) => setTimeout(r, 1300))

		// Verify second connect sent Last-Event-ID: 1
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		const secondHeaders = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<
			string,
			string
		>
		expect(secondHeaders['Last-Event-ID']).toBe('1')

		// All four items delivered
		expect(onItem).toHaveBeenCalledTimes(4)

		// Exactly one gap warning
		const warnCalls = onWarn.mock.calls.filter((c) => c[0] === 'warning')
		expect(warnCalls).toHaveLength(1)
		expect(warnCalls[0][1]).toMatch(/Replayed 3 frames/)

		// Not terminal
		expect(onTerminal).not.toHaveBeenCalled()

		await stream.stop()
	}, 3000)

	it('does not fire gap warning on the initial connect (no Last-Event-ID)', async () => {
		const frames = [
			buildSSEFrame({ n: 1 }, { id: '1' }),
			buildSSEFrame({ n: 2 }, { id: '2' }),
			buildSSEFrame({ n: 3 }, { id: '3' }),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(frames, { keepOpen: true }))

		const onWarn = vi.fn().mockResolvedValue(undefined)
		const onItem = vi.fn().mockResolvedValue(undefined)

		const stream = createManagedSSE<{ n: number }>({
			url: 'http://test/stream',
			headers: () => ({ Authorization: 'Bearer t' }),
			parseFrame: (frame) => {
				if (!frame.data) return null
				return { item: JSON.parse(frame.data) as { n: number } }
			},
			onItem,
			onWarn,
			onTerminal: vi.fn(),
			replayCap: 3,
			logTag: 'first-connect-test',
		})

		stream.addRef('sub-1')
		await new Promise((r) => setTimeout(r, 30))

		expect(onItem).toHaveBeenCalledTimes(3)
		const warnCalls = onWarn.mock.calls.filter((c) => c[0] === 'warning')
		expect(warnCalls).toHaveLength(0)

		await stream.stop()
	})
})

describe('createManagedSSE — ref counting', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('shares one connection across multiple refs', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeHangingSSEResponse())

		const stream = createManagedSSE<unknown>({
			url: 'http://test/stream',
			headers: () => ({}),
			parseFrame: () => null,
			onItem: vi.fn(),
			onWarn: vi.fn(),
			onTerminal: vi.fn(),
			replayCap: 100,
			logTag: 'refcount',
		})

		stream.addRef('a')
		stream.addRef('b')
		await Promise.resolve()
		await Promise.resolve()

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(stream.refCount()).toBe(2)
		expect(stream.hasRefs()).toBe(true)

		expect(stream.removeRef('a')).toBe(true)
		expect(stream.refCount()).toBe(1)
		expect(stream.removeRef('a')).toBe(false)

		await stream.stop()
	})
})
