import { describe, expect, it, vi } from 'vitest'
import { ImageWarmer } from '../services/image-warmer'

type Call = { args: readonly string[] }

function makeRunner(onCreate?: () => void) {
	const calls: Call[] = []
	const run = async (
		_bin: string,
		args: readonly string[],
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({ args })
		if (args[0] === 'create') onCreate?.()
		return { stdout: '', stderr: '' }
	}
	return { run, calls }
}

// Predictable suffixes so we can assert specific sandbox names.
function suffixFactory(): () => string {
	let n = 0
	return () => `s${n++}`
}

const IMAGE = 'maskin/agent-base:latest'

describe('ImageWarmer', () => {
	it('warms the cache once on start: one --pull always create, then a remove', async () => {
		const { run, calls } = makeRunner()
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await warmer.start()

		const creates = calls.filter((c) => c.args[0] === 'create')
		expect(creates.length).toBe(1)
		const createArgs = creates[0]?.args ?? []
		const idx = createArgs.indexOf('--pull')
		expect(createArgs[idx + 1]).toBe('always')

		// The throwaway VM is torn down immediately — nothing stays resident.
		const removes = calls.filter((c) => c.args[0] === 'remove')
		expect(removes.length).toBe(1)
		const name = createArgs[createArgs.indexOf('--name') + 1]
		const removeArgs = removes[0]?.args ?? []
		expect(removeArgs[removeArgs.length - 1]).toBe(name)
		expect(name).toBe('image-warmer-s0')

		expect(warmer.isWarm(IMAGE)).toBe(true)
	})

	it('isWarm is false for a different image', async () => {
		const { run } = makeRunner()
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await warmer.start()
		expect(warmer.isWarm('other/image:1.0')).toBe(false)
	})

	it('isWarm is false before start completes a warm', () => {
		const { run } = makeRunner()
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		expect(warmer.isWarm(IMAGE)).toBe(false)
	})

	it('stays on the cold path (isWarm false) when the warm create fails', async () => {
		const calls: Call[] = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ args })
			if (args[0] === 'create') throw new Error('libkrun: ENOSPC')
			return { stdout: '', stderr: '' }
		}
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		// start() must not throw — a failed warm is degraded, not fatal.
		await warmer.start()
		expect(warmer.isWarm(IMAGE)).toBe(false)
		// Best-effort cleanup of a half-created sandbox is attempted.
		expect(calls.some((c) => c.args[0] === 'remove')).toBe(true)
	})

	it('isWarm is false after shutdown', async () => {
		const { run } = makeRunner()
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
		})
		await warmer.start()
		expect(warmer.isWarm(IMAGE)).toBe(true)
		await warmer.shutdown()
		expect(warmer.isWarm(IMAGE)).toBe(false)
	})

	it('re-warms when the refresh interval fires', async () => {
		const { run, calls } = makeRunner()
		const triggers: Array<() => void> = []
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
			refreshMs: 60_000,
			// Capture the scheduled callback instead of relying on real timers.
			schedule: (fn) => {
				triggers.push(fn)
				return () => {}
			},
		})
		await warmer.start()
		expect(calls.filter((c) => c.args[0] === 'create').length).toBe(1)

		triggers[0]?.()
		await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === 'create').length).toBe(2))
	})

	it('does not schedule a refresh when refreshMs is 0', async () => {
		const { run } = makeRunner()
		let scheduled = false
		const warmer = new ImageWarmer({
			image: IMAGE,
			hostPort: 3001,
			msb: { msbBin: '/usr/local/bin/msb', run },
			randomSuffix: suffixFactory(),
			refreshMs: 0,
			schedule: () => {
				scheduled = true
				return () => {}
			},
		})
		await warmer.start()
		expect(scheduled).toBe(false)
	})
})
