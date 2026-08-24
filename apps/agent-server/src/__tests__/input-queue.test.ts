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

		// Reconnect, acking 'before' (seq 1) as the VM would after consuming it.
		// Without that ack 'before' is replayed too — retention is by ack, not
		// by whether the write succeeded.
		const received2: string[] = []
		await queue.registerStream(
			's1',
			async (line) => {
				received2.push(line)
				return true
			},
			1,
		)
		expect(received2).toEqual(['after\n'])
	})

	it('stale unregister from a replaced connection does not remove the new stream', async () => {
		const queue = new InputQueue()
		const staleUnregister = await queue.registerStream('s1', async () => true)

		// VM reconnects — a new stream replaces the old one for the same session
		const received: string[] = []
		await queue.registerStream('s1', async (line) => {
			received.push(line)
			return true
		})

		// The dead connection's cleanup fires late (heartbeat failure / abort)
		staleUnregister()

		await queue.enqueue('s1', 'msg\n')
		expect(received).toEqual(['msg\n'])
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

		// Reconnect acking msg1 (seq 1), the only one the VM actually consumed.
		// msg2 (the write that returned false) and msg3 are redelivered.
		const received2: string[] = []
		await queue.registerStream(
			's1',
			async (line) => {
				received2.push(line)
				return true
			},
			1,
		)
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

	// The production wedge (2026-08-24): a turn written into a socket whose
	// guest-side leg was dead. `s.write()` resolves as soon as the bytes reach
	// the kernel buffer, so the flusher reported success and the turn was
	// deleted — destroyed, not parked, and so never replayed on reconnect.
	// These cover the ack contract that makes a write-that-looked-fine
	// recoverable: a turn is only forgotten once the VM says it consumed it.
	describe('delivery is proven by ack, not by a successful write', () => {
		it('replays a turn the stream accepted but never acked', async () => {
			const queue = new InputQueue()
			// A blackholed stream: every write "succeeds", nothing ever arrives.
			await queue.registerStream('s1', async () => true)
			await queue.enqueue('s1', 'turn1\n')

			// The VM re-dials having seen nothing, so it acks nothing.
			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				0,
			)
			expect(received).toEqual(['turn1\n'])
		})

		it('drops turns the VM acked and replays only the rest', async () => {
			const queue = new InputQueue()
			await queue.registerStream('s1', async () => true)
			await queue.enqueue('s1', 'turn1\n')
			await queue.enqueue('s1', 'turn2\n')
			await queue.enqueue('s1', 'turn3\n')

			// The VM consumed turn1 and turn2, then the connection died.
			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				2,
			)
			expect(received).toEqual(['turn3\n'])
		})

		it('does not replay an acked turn on a later reconnect', async () => {
			const queue = new InputQueue()
			await queue.registerStream('s1', async () => true)
			await queue.enqueue('s1', 'turn1\n')
			await queue.registerStream('s1', async () => true, 1)

			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				1,
			)
			expect(received).toEqual([])
		})

		it('hands the seq to the flusher so the VM can report what it consumed', async () => {
			const queue = new InputQueue()
			const seen: number[] = []
			await queue.registerStream('s1', async (_line, seq) => {
				seen.push(seq)
				return true
			})
			await queue.enqueue('s1', 'a\n')
			await queue.enqueue('s1', 'b\n')
			expect(seen).toEqual([1, 2])
		})

		// Review catch: registering the flusher only after a single snapshot
		// pass left a window where an arriving turn found no stream, was parked,
		// and was never picked up — then a later live turn moved the VM's ack
		// past it and deleted it. Reproduced as seen === [1, 3].
		it('delivers a turn that arrives mid-replay, in order, without skipping it', async () => {
			const queue = new InputQueue()
			await queue.enqueue('s1', 'A\n')

			const seen: number[] = []
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			// Replay of A blocks, modelling a slow socket write.
			const registering = queue.registerStream(
				's1',
				async (_line, seq) => {
					seen.push(seq)
					if (seq === 1) await gate
					return true
				},
				0,
			)

			await new Promise((r) => setTimeout(r, 10))
			const b = queue.enqueue('s1', 'B\n') // lands mid-replay
			release()
			await registering
			await b
			await queue.enqueue('s1', 'C\n') // lands after registration
			await new Promise((r) => setTimeout(r, 10))

			expect(seen).toEqual([1, 2, 3])
		})

		// Review catch: seqs are per-process. A restarted agent-server hands out
		// seq 1 again while the VM still holds a mark of 12 — the guest would
		// discard every new turn as already-seen, and this ack would delete
		// them. An ack is only valid against the seq space that minted it.
		it('ignores an ack minted by a previous agent-server process', async () => {
			const queue = new InputQueue()
			await queue.enqueue('s1', 'after-restart\n') // seq 1 in the new epoch

			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				12, // stale high-water mark from before the restart
				'epoch-from-a-previous-process',
			)
			expect(received).toEqual(['after-restart\n'])
		})

		it('honours an ack minted by this process', async () => {
			const queue = new InputQueue()
			await queue.enqueue('s1', 'turn1\n')

			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				1,
				queue.epoch,
			)
			expect(received).toEqual([])
		})

		it('bounds the unacked buffer so a permanently dead stream cannot grow it forever', async () => {
			const queue = new InputQueue()
			await queue.registerStream('s1', async () => true)
			for (let i = 0; i < 300; i++) await queue.enqueue('s1', `turn${i}\n`)

			const received: string[] = []
			await queue.registerStream(
				's1',
				async (line) => {
					received.push(line)
					return true
				},
				0,
			)
			expect(received.length).toBeLessThanOrEqual(200)
			// The newest turns survive; the oldest are the ones dropped.
			expect(received.at(-1)).toBe('turn299\n')
		})
	})
})
