import { hasDriveIngested } from '@/lib/drive-first-call'
import { describe, expect, it } from 'vitest'
import { buildIntegrationResponse } from '../factories'

const STAMP = '2026-10-05T10:00:00.000Z'
const drive = (overrides = {}) =>
	buildIntegrationResponse({ provider: 'google-drive', externalId: 'a@b.test', ...overrides })

describe('hasDriveIngested', () => {
	it('is false with no Drive row', () => {
		expect(hasDriveIngested([])).toBe(false)
		expect(hasDriveIngested([buildIntegrationResponse({ provider: 'gmail' })])).toBe(false)
	})

	it('is false when config has no first_tool_call_at key', () => {
		expect(hasDriveIngested([drive({ config: {} })])).toBe(false)
		expect(hasDriveIngested([drive({ config: { drive: { peopleId: '1' } } })])).toBe(false)
	})

	it('is true once the key holds a timestamp', () => {
		expect(hasDriveIngested([drive({ config: { first_tool_call_at: STAMP } })])).toBe(true)
	})

	it('ignores a stamp that is not a string', () => {
		expect(hasDriveIngested([drive({ config: { first_tool_call_at: null } })])).toBe(false)
	})

	it('ignores a stamp on a revoked row and on another provider', () => {
		expect(
			hasDriveIngested([drive({ status: 'revoked', config: { first_tool_call_at: STAMP } })]),
		).toBe(false)
		expect(
			hasDriveIngested([
				buildIntegrationResponse({ provider: 'gmail', config: { first_tool_call_at: STAMP } }),
			]),
		).toBe(false)
	})
})
