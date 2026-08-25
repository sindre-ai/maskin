import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_VCPUS, resolveSessionVcpus } from '../lib/vcpus'

describe('resolveSessionVcpus', () => {
	it('gives a session one vCPU by default', () => {
		expect(resolveSessionVcpus(undefined, 12)).toBe(DEFAULT_SESSION_VCPUS)
		expect(DEFAULT_SESSION_VCPUS).toBe(1)
	})

	it('honours an explicit request', () => {
		expect(resolveSessionVcpus(4, 12)).toBe(4)
	})

	it('clamps an explicit request above the host core count', () => {
		expect(resolveSessionVcpus(32, 12)).toBe(12)
	})

	it('ignores a non-positive or fractional request', () => {
		expect(resolveSessionVcpus(0, 12)).toBe(1)
		expect(resolveSessionVcpus(-4, 12)).toBe(1)
		expect(resolveSessionVcpus(2.5, 12)).toBe(1)
	})
})
