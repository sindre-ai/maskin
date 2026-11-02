import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * v11 colour identity: the computed colours of the key tokens, in both themes, at the
 * three ship-gate viewports. Values come from the v11 handoff (colours only; the font is
 * unchanged). Dark mode is switched through the app's own `maskin-theme` key.
 */
const PALETTE = {
	light: {
		background: 'rgb(248, 250, 253)', // #f8fafd
		primaryButton: 'rgb(14, 20, 34)', // #0e1422 ink
		brand: 'rgb(31, 79, 224)', // #1f4fe0 cobalt
	},
	dark: {
		background: 'rgb(15, 18, 21)', // #0f1215
		primaryButton: 'rgb(233, 236, 239)', // #e9ecef
		brand: 'rgb(91, 134, 255)', // #5b86ff
	},
} as const

for (const theme of ['light', 'dark'] as const) {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`v11 colour tokens resolve in ${theme} mode at ${vp.label}`, async ({ page, account }) => {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page.locator('body')).toBeVisible()

			const expected = PALETTE[theme]

			// Body background and the document's resolved token on the root.
			await expect(page.locator('body')).toHaveCSS('background-color', expected.background)

			// Probe elements carry the real utility classes, so this proves the
			// Tailwind mapping (`bg-primary`, `text-brand`) resolves to the v11 values.
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
				}
			})

			expect(colours.primary.bg).toBe(expected.primaryButton)
			expect(colours.brand.color).toBe(expected.brand)
		})
	}
}
