import { SETTINGS_PAGES, matchSettingsPages } from '@/lib/palette/go-to'
import { describe, expect, it } from 'vitest'

describe('matchSettingsPages after the Objects to Item types rename', () => {
	it.each(['item types', 'item', 'objects', 'object', 'items'])(
		'finds Settings > Item types for "%s"',
		(query) => {
			const titles = matchSettingsPages(query).map((row) => row.title)
			expect(titles).toContain('Settings › Item types')
		},
	)

	it('keeps the settings route path unchanged', () => {
		const page = SETTINGS_PAGES.find((p) => p.label === 'Item types')
		expect(page?.path).toBe('settings/objects')
	})
})
