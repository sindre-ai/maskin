import { describe, expect, it, vi } from 'vitest'
import { WarmPool } from '../services/warm-pool'

type Call = { args: readonly string[] }

function makeRunner() {
	const calls: Call[] = []
	const run = async (
		_bin: string,
		args: readonly string[],
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({ args })
		return { stdout: '', stderr: '' }
	}
	return { run, calls }
}

// Predictable suffixes so we can assert specific sandbox names. The first call
// returns 's0', the second 's1', ...
function suffixFactory(): () => string {
	let n = 0
	return () => `s${n++}`
}

describe('WarmPool', () => {
	it('does nothing when size is 0', async () => {
		const { run, calls } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 0,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		expect(pool.readyCount()).toBe(0)
		expect(calls.length).toBe(0)
	})

	it('pre-creates N warm sandboxes on start', async () => {
		const { run, calls } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 3,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		expect(pool.readyCount()).toBe(3)
		const createCalls = calls.filter((c) => c.args[0] === 'create')
		expect(createCalls.length).toBe(3)
		// Each warm sandbox carries `--pull always` so the image cache is
		// populated.
		for (const c of createCalls) {
			const idx = c.args.indexOf('--pull')
			expect(c.args[idx + 1]).toBe('always')
		}
		// Names use the warm-pool-<index>-<suffix> shape.
		const names = createCalls.map((c) => c.args[c.args.indexOf('--name') + 1])
		expect(names).toEqual(['warm-pool-0-s0', 'warm-pool-1-s1', 'warm-pool-2-s2'])
	})

	it("claim() returns hit=false when the image doesn't match the pool image", async () => {
		const { run } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 2,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		const result = pool.claim('other/image:1.0')
		expect(result.hit).toBe(false)
		expect(pool.readyCount()).toBe(2)
	})

	it('claim() returns hit=true and removes a ready slot when the image matches', async () => {
		const { run } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 2,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		const result = pool.claim('maskin/agent-base:latest')
		expect(result.hit).toBe(true)
		// One slot was claimed; the other is still ready.
		expect(pool.readyCount()).toBe(1)
	})

	it('claim() schedules an async replacement (remove + new create) for the consumed slot', async () => {
		const { run, calls } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 1,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		const beforeCount = calls.length
		const result = pool.claim('maskin/agent-base:latest')
		expect(result.hit).toBe(true)
		// Replacement does `msb remove` then `msb create`, both of which involve
		// real filesystem work for the throwaway session dir. Poll until the
		// pool reports a ready slot again.
		await vi.waitFor(() => expect(pool.readyCount()).toBe(1), { timeout: 1_000, interval: 5 })
		const replaceCalls = calls.slice(beforeCount).map((c) => c.args[0])
		expect(replaceCalls).toContain('remove')
		expect(replaceCalls).toContain('create')
	})

	it('claim() returns hit=false once all ready slots are exhausted', async () => {
		// Make replacement create calls hang so the slot never returns to ready.
		const calls: Call[] = []
		let createCount = 0
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === 'create') {
				createCount += 1
				if (createCount > 1) {
					// Block forever — simulate slow image pull on replace.
					await new Promise(() => {})
				}
			}
			return { stdout: '', stderr: '' }
		}
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 1,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		expect(pool.claim('maskin/agent-base:latest').hit).toBe(true)
		await new Promise((r) => setImmediate(r))
		// Second claim has no ready slot — replacement is still in flight.
		expect(pool.claim('maskin/agent-base:latest').hit).toBe(false)
	})

	it('shutdown() removes every warm sandbox', async () => {
		const { run, calls } = makeRunner()
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 2,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		await pool.shutdown()
		const removeNames = calls
			.filter((c) => c.args[0] === 'remove')
			.map((c) => c.args[c.args.length - 1])
		expect(removeNames.sort()).toEqual(['warm-pool-0-s0', 'warm-pool-1-s1'])
		// After shutdown, claim is a no-op.
		expect(pool.claim('maskin/agent-base:latest').hit).toBe(false)
	})

	it('keeps the pool functional when a slot fails to warm', async () => {
		// Fail the second create only; the first and third succeed.
		const calls: Call[] = []
		let createCount = 0
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === 'create') {
				createCount += 1
				if (createCount === 2) throw new Error('libkrun: ENOSPC')
			}
			return { stdout: '', stderr: '' }
		}
		const pool = new WarmPool({
			image: 'maskin/agent-base:latest',
			size: 3,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await pool.start()
		// Two slots succeeded; one failed. We are degraded but serving.
		expect(pool.readyCount()).toBe(2)
		expect(pool.claim('maskin/agent-base:latest').hit).toBe(true)
	})
})
