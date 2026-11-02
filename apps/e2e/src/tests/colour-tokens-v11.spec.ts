import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Colour identity (v16 prototype palette): the computed colours of the key tokens, in both
 * themes, at the three ship-gate viewports. The font is unchanged. Dark mode is switched
 * through the app's own `maskin-theme` key.
 */
const PALETTE = {
	light: {
		background: 'rgb(255, 255, 255)', // #ffffff
		sidebar: 'rgb(246, 247, 249)', // #f6f7f9
		primaryButton: 'rgb(16, 19, 26)', // #10131a ink
		brand: 'rgb(37, 69, 200)', // #2545c8 cobalt
	},
	dark: {
		background: 'rgb(13, 15, 19)', // #0d0f13
		sidebar: 'rgb(17, 20, 25)', // #111419
		primaryButton: 'rgb(232, 234, 238)', // #e8eaee
		brand: 'rgb(106, 140, 255)', // #6a8cff
	},
} as const

for (const theme of ['light', 'dark'] as const) {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`colour tokens resolve in ${theme} mode at ${vp.label}`, async ({ page, account }) => {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page.locator('body')).toBeVisible()

			const expected = PALETTE[theme]
			await expect(page.locator('body')).toHaveCSS('background-color', expected.background)

			// Probe elements carry the real utility classes, so this proves the
			// Tailwind mapping (`bg-primary`, `text-brand`, `bg-sidebar`) resolves to the palette.
			const colours = await page.evaluate(() => {
				const make = (cls: string) => {
					const el = document.createElement('div')
					el.className = cls
					document.body.appendChild(el)
					const cs = getComputedStyle(el)
					const out = { bg: cs.backgroundColor, color: cs.color }
					el.remove()
					return out
				}
				return {
					primary: make('bg-primary text-primary-foreground'),
					brand: make('text-brand'),
					sidebar: make('bg-sidebar'),
				}
			})

			expect(colours.primary.bg).toBe(expected.primaryButton)
			expect(colours.brand.color).toBe(expected.brand)
			expect(colours.sidebar.bg).toBe(expected.sidebar)
		})
	}
}
