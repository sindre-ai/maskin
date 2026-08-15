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
			// anywhere on the card body — not just the title — must navigate. Click
			// near the card's top-left (over the title) rather than its default
			// centroid: bundle cards with many composition chips wrap the chip row
			// across multiple lines, and those chip buttons paint above the card's
			// full-bleed overlay link (by design, so they can catch their own
			// hover/tooltip clicks) — a centroid click can land on a chip instead
			// of the link on cards with enough items to wrap that far down.
			await firstCard.getByRole('link').click({ position: { x: 10, y: 10 } })

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
		// Scoped to `main` — the global chat panel's "Pick an agent" selector
		// also displays the bare text "Agent" as its current value, and an
		// unscoped getByText matches both.
		await expect(page.getByRole('main').getByText(/^AGENT$/i)).toBeVisible()

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
		// though a real click there lands on the card's link underneath. Raw
		// `page.mouse.click` operates in viewport coordinates and — unlike
		// locator.click() — never auto-scrolls, so the first "not yet installed"
		// card must be scrolled into view first: with enough marketplace items
		// already installed in this workspace, it can sit below the fold.
		const chip = card.getByText(/^(Agent|Trigger|Skill|Integration)$/)
		await chip.scrollIntoViewIfNeeded()
		const chipBox = await chip.boundingBox()
		if (!chipBox) throw new Error('missing chip bounding box')
		await page.mouse.click(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2)

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/[^/]+$/)
		await expect(page.getByRole('heading', { name: itemName ?? '', level: 1 })).toBeVisible({
			timeout: 20000,
		})

		await page.goBack()
		await expect(agentsSection).toBeVisible({ timeout: 20000 })

		// Re-scope by the item's name rather than reusing `card`: that locator
		// filters on "has an Install button", and once the click below flips the
		// button to "Installed" the same filter stops matching this card — a
		// live re-evaluation would silently jump to the next not-yet-installed
		// card instead of observing this one's new state.
		const stableCard = agentsSection
			.locator('article')
			.filter({ has: page.getByRole('heading', { name: itemName ?? '', level: 3 }) })

		// The Install button is the one part of the card that must NOT
		// navigate — it installs the item in place instead of opening it.
		await stableCard.getByRole('button', { name: /^install$/i }).click()
		await expect(stableCard.getByText('Installed')).toBeVisible()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/marketplace$`))
	})
})
