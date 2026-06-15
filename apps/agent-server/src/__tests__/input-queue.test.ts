import { describe, expect, it } from 'vitest'
import { InputQueue } from '../services/input-queue'

describe('InputQueue', () => {
	it('flushes to connected stream immediately', () => {
		const queue = new InputQueue()
		const received: string[] = []
		queue.registerStream('s1', (line) => {
			received.push(line)
			return true
		})
		queue.enqueue('s1', 'msg1\n')
		queue.enqueue('s1', 'msg2\n')
		expect(received).toEqual(['msg1\n', 'msg2\n'])
	})

	it('parks messages before stream connects, flushes on registerStream', () => {
		const queue = new InputQueue()
		queue.enqueue('s1', 'msg1\n')
		queue.enqueue('s1', 'msg2\n')
		const received: string[] = []
		queue.registerStream('s1', (line) => {
			received.push(line)
			return true
		})
		expect(received).toEqual(['msg1\n', 'msg2\n'])
	})

	it('unregister removes the stream so subsequent enqueues park', () => {
		const queue = new InputQueue()
		const received: string[] = []
		const unregister = queue.registerStream('s1', (line) => {
			received.push(line)
			return true
		})
		queue.enqueue('s1', 'before\n')
		unregister()
		queue.enqueue('s1', 'after\n')
		expect(received).toEqual(['before\n'])

		// Reconnect — should receive the parked message
		const received2: string[] = []
		queue.registerStream('s1', (line) => {
			received2.push(line)
			return true
		})
		expect(received2).toEqual(['after\n'])
	})

	it('re-parks message and unregisters stream when flusher returns false', () => {
		const queue = new InputQueue()
		const received: string[] = []
		queue.registerStream('s1', (line) => {
			received.push(line)
			return false // signal closed
		})
		queue.enqueue('s1', 'msg\n')
		expect(received).toEqual(['msg\n'])

		// Stream was closed — message should be re-parked for next connection
		const received2: string[] = []
		queue.registerStream('s1', (line) => {
			received2.push(line)
			return true
		})
		expect(received2).toEqual(['msg\n'])
	})

	it('drainSession removes both stream and pending queue', () => {
		const queue = new InputQueue()
		queue.enqueue('s1', 'pending\n')
		queue.drainSession('s1')

		const received: string[] = []
		queue.registerStream('s1', (line) => {
			received.push(line)
			return true
		})
		expect(received).toEqual([])
	})

	it('isolates sessions from each other', () => {
		const queue = new InputQueue()
		const r1: string[] = []
		const r2: string[] = []
		queue.registerStream('s1', (line) => {
			r1.push(line)
			return true
		})
		queue.registerStream('s2', (line) => {
			r2.push(line)
			return true
		})
		queue.enqueue('s1', 'for-s1\n')
		queue.enqueue('s2', 'for-s2\n')
		expect(r1).toEqual(['for-s1\n'])
		expect(r2).toEqual(['for-s2\n'])
	})
})
