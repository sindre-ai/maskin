import { SECRET_PATTERNS } from '@maskin/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

const posthogMock = vi.hoisted(() => ({ getFeatureFlagPayload: vi.fn() }))
vi.mock('posthog-js', () => ({ default: posthogMock }))

import {
	applyScannerPayload,
	currentScannerTable,
	hasHighConfidenceSecret,
	isPatternEnabledForWorkspace,
	scanComposerText,
} from '@/lib/secret-scanner'

// Obviously fake, assembled at runtime.
const fakeGithub = `ghp_${'a'.repeat(36)}`

afterEach(() => posthogMock.getFeatureFlagPayload.mockReset())

describe('applyScannerPayload', () => {
	it('keeps the shipped table for a payload it cannot read', () => {
		expect(applyScannerPayload('nope')).toBe(SECRET_PATTERNS)
		expect(applyScannerPayload({})).toBe(SECRET_PATTERNS)
		expect(applyScannerPayload([])).toBe(SECRET_PATTERNS)
	})

	it('replaces the regex of a known provider, in both accepted shapes', () => {
		const row = { id: 'github', source: '\\bghp_[A-Za-z0-9]{36,}\\b' }
		for (const payload of [[row], { patterns: [row] }]) {
			const table = applyScannerPayload(payload)
			expect(table.find((p) => p.id === 'github')?.source).toBe(row.source)
			expect(table.find((p) => p.id === 'stripe')).toEqual(
				SECRET_PATTERNS.find((p) => p.id === 'stripe'),
			)
		}
	})

	it('cannot add a provider or change confidence', () => {
		const table = applyScannerPayload([
			{ id: 'notion', source: 'secret_[A-Za-z0-9]{40,}' },
			{ id: 'cf-ray', source: 'x', confidence: 'high' },
		])
		expect(table.map((p) => p.id)).toEqual(SECRET_PATTERNS.map((p) => p.id))
		expect(table.find((p) => p.id === 'cf-ray')?.confidence).toBe('low')
	})

	it('skips a regex that does not compile, is oversized, or is catastrophically slow', () => {
		const bad = [
			{ id: 'github', source: '(' },
			{ id: 'slack', source: 'a'.repeat(401) },
			{ id: 'stripe', source: '^(a+)+$' },
		]
		const table = applyScannerPayload(bad)
		for (const id of ['github', 'slack', 'stripe']) {
			expect(table.find((p) => p.id === id)?.source).toBe(
				SECRET_PATTERNS.find((p) => p.id === id)?.source,
			)
		}
	})
})

describe('currentScannerTable', () => {
	it('falls back to the compile-time table when the flag has no payload', () => {
		posthogMock.getFeatureFlagPayload.mockReturnValue(undefined)
		expect(currentScannerTable()).toBe(SECRET_PATTERNS)
	})

	it('falls back when PostHog throws', () => {
		posthogMock.getFeatureFlagPayload.mockImplementation(() => {
			throw new Error('not initialised')
		})
		expect(currentScannerTable()).toBe(SECRET_PATTERNS)
	})

	it('uses a valid payload from the flag', () => {
		posthogMock.getFeatureFlagPayload.mockReturnValue([
			{ id: 'slack', source: '\\bxoxb-[0-9]{20,}' },
		])
		expect(currentScannerTable().find((p) => p.id === 'slack')?.source).toBe('\\bxoxb-[0-9]{20,}')
	})
})

describe('scanComposerText', () => {
	it('flags a high-confidence secret and honours session mutes', () => {
		posthogMock.getFeatureFlagPayload.mockReturnValue(undefined)
		expect(scanComposerText(fakeGithub, { workspaceId: 'w' })[0]?.confidence).toBe('high')
		expect(
			scanComposerText(fakeGithub, { workspaceId: 'w', mutedPatternIds: new Set(['github']) }),
		).toEqual([])
	})

	it('the workspace hook is a passthrough returning true', () => {
		expect(isPatternEnabledForWorkspace('any', 'github')).toBe(true)
	})

	it('hasHighConfidenceSecret ignores amber matches', () => {
		posthogMock.getFeatureFlagPayload.mockReturnValue(undefined)
		expect(hasHighConfidenceSecret(fakeGithub, 'w')).toBe(true)
		expect(hasHighConfidenceSecret('x'.repeat(64), 'w')).toBe(false)
	})
})
