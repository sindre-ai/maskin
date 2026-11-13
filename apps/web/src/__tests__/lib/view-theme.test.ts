import { applyAppTheme } from '@/lib/view-theme'
import { describe, expect, it } from 'vitest'

const PAGE =
	'<!doctype html><html><head><style>@media (prefers-color-scheme:dark){body{background:#000}}@media screen and (prefers-color-scheme: light){body{background:#fff}}</style></head><body></body></html>'

describe('applyAppTheme', () => {
	it('makes the dark styles apply and the light ones not when the app is dark', () => {
		const out = applyAppTheme(PAGE, 'dark')
		expect(out).toContain('@media (min-width: 0px){body{background:#000}}')
		expect(out).toContain('@media screen and (max-width: 0px){body{background:#fff}}')
		expect(out).not.toMatch(/prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{/)
	})

	it('does the reverse when the app is light', () => {
		const out = applyAppTheme(PAGE, 'light')
		expect(out).toContain('@media (max-width: 0px){body{background:#000}}')
		expect(out).toContain('@media screen and (min-width: 0px){body{background:#fff}}')
	})

	it('sets the document colour scheme and answers matchMedia for the page scripts', () => {
		const out = applyAppTheme(PAGE, 'dark')
		expect(out).toContain('<meta name="color-scheme" content="dark">')
		expect(out).toContain(':root{color-scheme:dark !important}')
		expect(out).toContain('window.matchMedia=')
	})

	it('puts the patch ahead of the page scripts', () => {
		const out = applyAppTheme('<html><head><script>x()</script></head></html>', 'dark')
		expect(out.indexOf('window.matchMedia=')).toBeLessThan(out.indexOf('x()'))
	})
})
