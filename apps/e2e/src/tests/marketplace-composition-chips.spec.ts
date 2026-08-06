import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers T1 of "Marketplace page polish": composition chip row on bundle
// (multi-type) package cards. The seeded catalog includes at least the CCD
// bundle which ships multiple actors + triggers, so bundle cards must render
// the composition row on every ship-gate viewport.

test.describe('Marketplace — composition chip row on bundle cards', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the composition row on bundle cards at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/marketplace`)
			await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible({
				timeout: 20000,
			})

			// The Packages section only appears when at least one multi-type package
			// exists in the catalog — CCD (Discover & Research Loop) is that card.
			const packagesSection = page.getByRole('region', { name: 'Packages' })
			await expect(packagesSection).toBeVisible({ timeout: 20000 })

			// At least one composition row is present under Packages. Every bundle
			// card in the section must expose its row.
			const compositionRows = packagesSection.getByLabel('Package composition')
			await expect(compositionRows.first()).toBeVisible()
			const rowCount = await compositionRows.count()
			expect(rowCount).toBeGreaterThan(0)

			// Bundle cards in the catalog include at least one trigger, so the
			// count chip should render on the first bundle.
			await expect(compositionRows.first().getByText(/\d+ triggers?/)).toBeVisible()

			// The row wraps freely; the parent card must not overflow the viewport.
			const firstRow = compositionRows.first()
			const overflows = await firstRow.evaluate((el) => {
				const card = el.closest('article')
				if (!card) return true
				return card.scrollWidth > card.clientWidth + 1
			})
			expect(overflows).toBe(false)
		})

		test(`does not render the composition row on single-type cards at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/marketplace`)
			await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible({
				timeout: 20000,
			})

			// Agents section holds single-type actor packages plus per-item cards
			// from bundles. Neither should render the composition row — that row
			// is scoped to bundle cards under "Packages".
			const agentsSection = page.getByRole('region', { name: 'Agents' })
			await expect(agentsSection).toBeVisible({ timeout: 20000 })
			await expect(agentsSection.getByLabel('Package composition')).toHaveCount(0)
		})
	}

	test('hover surfaces the full component name in a tooltip', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.goto(`/${account.workspaceId}/marketplace`)
		await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible({
			timeout: 20000,
		})

		const packagesSection = page.getByRole('region', { name: 'Packages' })
		const chipRow = packagesSection.getByLabel('Package composition').first()
		await expect(chipRow).toBeVisible({ timeout: 20000 })

		// The first non-trigger chip has its full component name as aria-label.
		// Hovering it must reveal the same name inside a Radix Tooltip.Content.
		const firstChip = chipRow.getByRole('button').first()
		const fullName = await firstChip.getAttribute('aria-label')
		expect(fullName).toBeTruthy()

		await firstChip.hover()
		const tooltip = page.getByRole('tooltip', { name: fullName ?? '' })
		await expect(tooltip).toBeVisible({ timeout: 5000 })
	})

	test('tap on mobile surfaces the tooltip via focus', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })

		await page.goto(`/${account.workspaceId}/marketplace`)
		await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible({
			timeout: 20000,
		})

		const packagesSection = page.getByRole('region', { name: 'Packages' })
		const chipRow = packagesSection.getByLabel('Package composition').first()
		await expect(chipRow).toBeVisible({ timeout: 20000 })
		const firstChip = chipRow.getByRole('button').first()
		const fullName = await firstChip.getAttribute('aria-label')
		expect(fullName).toBeTruthy()

		// Touch tap is Radix's supported way to open the tooltip on mobile.
		await firstChip.dispatchEvent('pointerdown', { pointerType: 'touch' })
		await firstChip.dispatchEvent('pointerup', { pointerType: 'touch' })
		await firstChip.focus()
		const tooltip = page.getByRole('tooltip', { name: fullName ?? '' })
		await expect(tooltip).toBeVisible({ timeout: 5000 })
	})
})
