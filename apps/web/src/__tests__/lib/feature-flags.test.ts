import { isForyouSparseComposerEnabled } from '@/lib/feature-flags'
import { afterEach, describe, expect, it, vi } from 'vitest'

const FOUNDER_A = '00000000-0000-0000-0000-000000000001'
const FOUNDER_B = '00000000-0000-0000-0000-000000000002'
const OTHER = '00000000-0000-0000-0000-000000000099'

function ws(id: string) {
	return { id }
}

describe('isForyouSparseComposerEnabled', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('returns false when the env var is unset (AC-T4 default)', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', '')
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(false)
	})

	it('returns false when the env var is blank/whitespace', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', '   ,  ')
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(false)
	})

	it('returns true for workspaces explicitly in the allowlist', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', `${FOUNDER_A},${FOUNDER_B}`)
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(true)
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_B))).toBe(true)
	})

	it('returns false for workspaces not in the allowlist', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', `${FOUNDER_A},${FOUNDER_B}`)
		expect(isForyouSparseComposerEnabled(ws(OTHER))).toBe(false)
	})

	it('matches case-insensitively (workspace UUID may be upper-case)', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', FOUNDER_A.toUpperCase())
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(true)
	})

	it('ignores whitespace around each entry', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', `  ${FOUNDER_A}  ,  ${FOUNDER_B}  `)
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(true)
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_B))).toBe(true)
	})

	it('enables every workspace when the value is the wildcard', () => {
		vi.stubEnv('VITE_FORYOU_COMPOSER_WORKSPACES', '*')
		expect(isForyouSparseComposerEnabled(ws(FOUNDER_A))).toBe(true)
		expect(isForyouSparseComposerEnabled(ws(OTHER))).toBe(true)
	})
})
