import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers T1 of the Marketplace polish bet: the composition chip row on
// multi-item bundle loop cards (loops with ≥2 component types).
// The dev bootstrap seeds four bundle loops (Discover & Research, Build &
// Ship, Strategy & Growth, Team Ops), each carrying actor + trigger + skill
// items — so the marketplace loads a real 3+ bundle-card grid without extra
// setup.

const CHIP_ROW = '[data-testid="composition-chip-row"]'

test.describe('Marketplace composition chip row', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders on bundle cards and wraps without truncation at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			// Wait for the Loops section (bundle-card container) to render.
			const loopsSection = page.getByRole('region', { name: 'Loops' })
			await expect(loopsSection).toBeVisible({ timeout: 20000 })

			// AC: every bundle card shows the composition chip row.
			const chipRows = loopsSection.locator(CHIP_ROW)
			const rowCount = await chipRows.count()
			expect(rowCount).toBeGreaterThanOrEqual(1)
			for (let i = 0; i < rowCount; i++) {
				await expect(chipRows.nth(i)).toBeVisible()
			}

			// AC: the row wraps without truncation — no chip may overflow the card.
			// The chip row uses flex-wrap, so scrollWidth must never exceed clientWidth.
			for (let i = 0; i < rowCount; i++) {
				const overflow = await chipRows.nth(i).evaluate((el) => {
					const box = el as HTMLElement
					return { scroll: box.scrollWidth, client: box.clientWidth }
				})
				expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)
			}

			// AC: at least one trigger count chip renders on a bundle card — the
			// seeded bundles all include multiple triggers.
			await expect(loopsSection.getByText(/\d+ triggers?/).first()).toBeVisible()
		})
	}

	test('single-type item cards do not render the composition chip row at 1024px', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		// Agents section holds individual-item cards from multi-type loops
		// (item cards) — those never render the chip row.
		const agents = page.getByRole('region', { name: 'Agents' })
		await expect(agents).toBeVisible({ timeout: 20000 })
		await expect(agents.locator(CHIP_ROW)).toHaveCount(0)
	})

	test('hovering a composition chip surfaces the full component name in a tooltip', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		const loopsSection = page.getByRole('region', { name: 'Loops' })
		await expect(loopsSection).toBeVisible({ timeout: 20000 })

		const firstChip = loopsSection.locator(CHIP_ROW).first().locator('> *').first()
		await firstChip.scrollIntoViewIfNeeded()
		await firstChip.hover()

		// Radix Tooltip content renders into a portal with role="tooltip"
		// once the trigger is hovered/focused.
		await expect(page.locator('[role="tooltip"]').first()).toBeVisible({ timeout: 5000 })
	})
})
