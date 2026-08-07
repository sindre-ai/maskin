import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers the marketplace subpages bet: clicking a catalog card opens a
// read-only detail page (loop bundle, or a single item within a bundle)
// instead of doing nothing. The dev bootstrap seeds bundle loops (actor +
// trigger + skill items), so the marketplace grid has both loop cards and
// individual item cards without extra setup.

test.describe('Marketplace detail pages', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`opens a loop's detail page and returns via back @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const loopsSection = page.getByRole('region', { name: 'Loops' })
			await expect(loopsSection).toBeVisible({ timeout: 20000 })

			const firstCard = loopsSection.locator('article').first()
			const loopName = (await firstCard.locator('h3').first().textContent())?.trim()
			expect(loopName).toBeTruthy()

			// The whole card is clickable (except the install controls), so clicking
			// anywhere on the card body — not just the title — must navigate.
			await firstCard.getByRole('link').click()

			await expect(page).toHaveURL(/\/marketplace\/[^/]+\/?$/)
			await expect(page.getByRole('heading', { name: loopName ?? '', level: 1 })).toBeVisible({
				timeout: 20000,
			})
			await expect(page.getByText('What it brings')).toBeVisible()

			// Layout gate — the detail page must not overflow the viewport.
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)

			await page.getByRole('button', { name: 'Go back' }).click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/marketplace$`))
			await expect(loopsSection).toBeVisible()
		})
	}

	test('opens an item detail page from the Agents section and links back to its loop', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		const agentsSection = page.getByRole('region', { name: 'Agents' })
		await expect(agentsSection).toBeVisible({ timeout: 20000 })

		const firstItemCard = agentsSection.locator('article').first()
		const itemName = (await firstItemCard.locator('h3').first().textContent())?.trim()
		expect(itemName).toBeTruthy()

		await firstItemCard.getByRole('link').click()

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/[^/]+$/)
		await expect(page.getByRole('heading', { name: itemName ?? '', level: 1 })).toBeVisible({
			timeout: 20000,
		})
		await expect(page.getByText(/^AGENT$/i)).toBeVisible()

		const partOfLink = page.getByRole('link', { name: /^Part of / })
		await expect(partOfLink).toBeVisible()
		await partOfLink.click()

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/?$/)
		await expect(page.getByText('What it brings')).toBeVisible({ timeout: 20000 })
	})

	test('clicking non-interactive card content still opens the detail page, but Install installs in place', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		const agentsSection = page.getByRole('region', { name: 'Agents' })
		await expect(agentsSection).toBeVisible({ timeout: 20000 })

		const card = agentsSection
			.locator('article')
			.filter({ has: page.getByRole('button', { name: /^install$/i }) })
			.first()
		await expect(card).toBeVisible()
		const itemName = (await card.locator('h3').first().textContent())?.trim()
		expect(itemName).toBeTruthy()

		// The type-chip text has no click handler of its own — clicking it must
		// still fall through to the card's link, proving the whole card (not
		// just the title) is clickable. Real mouse coordinates are used (rather
		// than locator.click()) since the chip itself is pointer-events:none and
		// would fail Playwright's "receives events" actionability check even
		// though a real click there lands on the card's link underneath.
		const chip = card.getByText(/^(Agent|Trigger|Skill|Integration)$/)
		const chipBox = await chip.boundingBox()
		if (!chipBox) throw new Error('missing chip bounding box')
		await page.mouse.click(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2)

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/[^/]+$/)
		await expect(page.getByRole('heading', { name: itemName ?? '', level: 1 })).toBeVisible({
			timeout: 20000,
		})

		await page.goBack()
		await expect(agentsSection).toBeVisible({ timeout: 20000 })

		// The Install button is the one part of the card that must NOT
		// navigate — it installs the item in place instead of opening it.
		await card.getByRole('button', { name: /^install$/i }).click()
		await expect(card.getByText('Installed')).toBeVisible()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/marketplace$`))
	})
})
