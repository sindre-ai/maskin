import { describe, expect, it } from 'vitest'
import {
	MAX_DEFAULT_SESSION_VCPUS,
	browserSidecarVcpus,
	defaultSessionVcpus,
	resolveSessionVcpus,
} from '../lib/vcpus'

describe('defaultSessionVcpus', () => {
	it('reserves two cores for the host', () => {
		expect(defaultSessionVcpus(8)).toBe(6)
	})

	it('caps the default so one session cannot claim a whole large box', () => {
		expect(defaultSessionVcpus(64)).toBe(MAX_DEFAULT_SESSION_VCPUS)
	})

	it('returns at least one vCPU on a box smaller than the reservation', () => {
		expect(defaultSessionVcpus(1)).toBe(1)
		expect(defaultSessionVcpus(2)).toBe(1)
	})

	it('prefers the override when set', () => {
		expect(defaultSessionVcpus(12, 3)).toBe(3)
	})

	it('clamps an override above the host core count', () => {
		expect(defaultSessionVcpus(4, 99)).toBe(4)
	})

	it('ignores a non-positive or fractional override', () => {
		expect(defaultSessionVcpus(12, 0)).toBe(8)
		expect(defaultSessionVcpus(12, -4)).toBe(8)
		expect(defaultSessionVcpus(12, 2.5)).toBe(8)
	})
})

describe('resolveSessionVcpus', () => {
	it('honours an explicit request', () => {
		expect(resolveSessionVcpus(2, 12)).toBe(2)
	})

	it('lets an explicit request exceed the default cap, up to the host core count', () => {
		expect(resolveSessionVcpus(12, 12)).toBe(12)
	})

	it('clamps an explicit request above the host core count', () => {
		expect(resolveSessionVcpus(32, 12)).toBe(12)
	})

	it('falls back to the host default when nothing is requested', () => {
		expect(resolveSessionVcpus(undefined, 12)).toBe(8)
	})

	it('uses the configured fallback when nothing is requested', () => {
		expect(resolveSessionVcpus(undefined, 12, 4)).toBe(4)
	})

	it('never returns the old single-vCPU value on a multi-core box', () => {
		expect(resolveSessionVcpus(undefined, 12)).toBeGreaterThan(1)
	})
})

describe('browserSidecarVcpus', () => {
	it('gives Chromium two vCPUs on a multi-core box', () => {
		expect(browserSidecarVcpus(12)).toBe(2)
	})

	it('never exceeds the host core count', () => {
		expect(browserSidecarVcpus(1)).toBe(1)
	})
})
