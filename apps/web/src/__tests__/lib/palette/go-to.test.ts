import { SETTINGS_ROWS_MAX, matchSettingsPages } from '@/lib/palette/go-to'
import { describe, expect, it } from 'vitest'

describe('matchSettingsPages', () => {
	it('adds a Settings › Keychain row for "keychain"', () => {
		expect(matchSettingsPages('keychain')).toEqual([
			{ title: 'Settings › Keychain', path: 'settings/keychain' },
		])
	})

	it('adds nothing for an empty query or an unrelated one', () => {
		expect(matchSettingsPages('')).toEqual([])
		expect(matchSettingsPages('zebra')).toEqual([])
	})

	it('offers Keys only to enterprise workspaces', () => {
		expect(matchSettingsPages('keys')).toEqual([])
		expect(matchSettingsPages('keys', { enterprise: false })).toEqual([])
		expect(matchSettingsPages('keys', { enterprise: true })).toEqual([
			{ title: 'Settings › Keys', path: 'settings/keys' },
		])
	})

	it('never returns more than four rows', () => {
		const rows = matchSettingsPages('e')
		expect(rows.length).toBe(SETTINGS_ROWS_MAX)
	})
})
