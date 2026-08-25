import { describe, expect, it } from 'vitest'
import { computeSessionCapacity } from '../lib/capacity'

// The production box this was sized against: 12 cores, 64 GiB, 4 GiB sessions.
const FINLAND = { hostCores: 12, totalMemoryMib: 64_219, sessionMemoryMib: 4096 }

describe('computeSessionCapacity', () => {
	it('fills the box up to its core count, minus the host reservation', () => {
		const result = computeSessionCapacity(FINLAND)
		expect(result.capacity).toBe(10)
		expect(result.boundBy).toBe('cpu')
	})

	it('takes the memory bound when RAM is the tighter constraint', () => {
		const result = computeSessionCapacity({
			hostCores: 32,
			totalMemoryMib: 32_768,
			sessionMemoryMib: 4096,
		})
		// (32768 - 8192 reserved) / 4096 = 6
		expect(result.capacity).toBe(6)
		expect(result.boundBy).toBe('memory')
		expect(result.cpuBound).toBe(30)
	})

	it('never promises more memory than the box has — the 50-session regression', () => {
		const result = computeSessionCapacity(FINLAND)
		expect(result.capacity * FINLAND.sessionMemoryMib).toBeLessThan(FINLAND.totalMemoryMib)
	})

	it('scales down when each session is given a bigger memory budget', () => {
		const big = computeSessionCapacity({ ...FINLAND, sessionMemoryMib: 16_384 })
		expect(big.capacity).toBe(3)
		expect(big.boundBy).toBe('memory')
	})

	it('returns at least one session on a box smaller than the reservations', () => {
		const tiny = computeSessionCapacity({
			hostCores: 1,
			totalMemoryMib: 2048,
			sessionMemoryMib: 4096,
		})
		expect(tiny.capacity).toBe(1)
	})

	it('lets an operator override win outright', () => {
		const result = computeSessionCapacity({ ...FINLAND, override: 25 })
		expect(result.capacity).toBe(25)
		expect(result.boundBy).toBe('override')
	})

	it('ignores a non-positive or fractional override', () => {
		expect(computeSessionCapacity({ ...FINLAND, override: 0 }).capacity).toBe(10)
		expect(computeSessionCapacity({ ...FINLAND, override: 2.5 }).capacity).toBe(10)
	})

	it('still reports both bounds when an override is in play, for the boot log', () => {
		const result = computeSessionCapacity({ ...FINLAND, override: 25 })
		expect(result.cpuBound).toBe(10)
		expect(result.memoryBound).toBe(13)
	})
})
