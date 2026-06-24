import { describe, expect, it } from 'vitest'
import { InputQueue } from '../services/input-queue'

describe('InputQueue', () => {
	it('flushes to connected stream immediately', async () => {
		const queue = new InputQueue()
		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return true
		})
		await queue.enqueue('s1', 'msg1\n')
		await queue.enqueue('s1', 'msg2\n')
		expect(received).toEqual(['msg1\n', 'msg2\n'])
	})

	it('parks messages before stream connects, flushes on registerStream', async () => {
		const queue = new InputQueue()
		await queue.enqueue('s1', 'msg1\n')
		await queue.enqueue('s1', 'msg2\n')
		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return true
		})
		expect(received).toEqual(['msg1\n', 'msg2\n'])
	})

	it('unregister removes the stream so subsequent enqueues park', async () => {
		const queue = new InputQueue()
		const received: string[] = []
		const unregister = await queue.registerStream('s1', async (line) => {
			received.push(line)
			return true
		})
		await queue.enqueue('s1', 'before\n')
		unregister()
		await queue.enqueue('s1', 'after\n')
		expect(received).toEqual(['before\n'])

		// Reconnect — should receive the parked message
		const received2: string[] = []
		await queue.registerStream('s1', async (line) => {
			received2.push(line)
			return true
		})
		expect(received2).toEqual(['after\n'])
	})

	it('re-parks message and unregisters stream when flusher returns false', async () => {
		const queue = new InputQueue()
		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return false // signal closed
		})
		await queue.enqueue('s1', 'msg\n')
		expect(received).toEqual(['msg\n'])

		// Stream was closed — message should be re-parked for next connection
		const received2: string[] = []
		await queue.registerStream('s1', async (line) => {
			received2.push(line)
			return true
		})
		expect(received2).toEqual(['msg\n'])
	})

	it('re-parks failed message and remainder when flusher returns false during initial flush', async () => {
		const queue = new InputQueue()
		await queue.enqueue('s1', 'msg1\n')
		await queue.enqueue('s1', 'msg2\n')
		await queue.enqueue('s1', 'msg3\n')

		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return line !== 'msg2\n' // close on second message
		})
		expect(received).toEqual(['msg1\n', 'msg2\n'])

		// msg2 (the one that returned false) and msg3 should be re-parked
		const received2: string[] = []
		await queue.registerStream('s1', async (line) => {
			received2.push(line)
			return true
		})
		expect(received2).toEqual(['msg2\n', 'msg3\n'])
	})

	it('drainSession removes both stream and pending queue', async () => {
		const queue = new InputQueue()
		await queue.enqueue('s1', 'pending\n')
		queue.drainSession('s1')

		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return true
		})
		expect(received).toEqual([])
	})

	it('isolates sessions from each other', async () => {
		const queue = new InputQueue()
		const r1: string[] = []
		const r2: string[] = []
		await queue.registerStream('s1', async (line) => {
			r1.push(line)
			return true
		})
		await queue.registerStream('s2', async (line) => {
			r2.push(line)
			return true
		})
		await queue.enqueue('s1', 'for-s1\n')
		await queue.enqueue('s2', 'for-s2\n')
		expect(r1).toEqual(['for-s1\n'])
		expect(r2).toEqual(['for-s2\n'])
	})
})
