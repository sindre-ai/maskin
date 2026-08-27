import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Covers the v2 marketplace install state (mockup 2596–2597 on the card,
// 2613/2636 on the detail page): once a loop is installed the catalog card
// reads "✓ Installed" with a Manage link instead of a bare Install button, the
// state survives a reload, and the detail page's action bar (breadcrumb +
// Manage + ⋯) is reachable without scrolling at every ship-gate viewport.
//
// The dev bootstrap seeds four bundle loops, so the Loops section always has a
// card to install. Each test installs and then removes, leaving the workspace
// as it found it.

// Exact — an item card titled e.g. "Influencer Manager Agent" also contains "Manage".
const MANAGE = { name: 'Manage', exact: true }

test.describe('Marketplace install state', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`card flips to Installed + Manage and back at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const loopsSection = page.getByRole('region', { name: 'Loops' })
			await expect(loopsSection).toBeVisible({ timeout: 20000 })

			const card = loopsSection.locator('article').first()
			const loopName = (await card.getByRole('heading', { level: 3 }).textContent())?.trim()
			expect(loopName).toBeTruthy()

			// Fresh workspace: not installed yet.
			const installButton = card.getByRole('button', { name: /^install$/i })
			await expect(installButton).toBeVisible()
			await expect(card.getByText('Installed')).toHaveCount(0)

			await installButton.click()

			// The footer flips to the installed pair (mockup 2596–2597).
			await expect(card.getByText('Installed')).toBeVisible({ timeout: 20000 })
			const manage = card.getByRole('link', MANAGE)
			await expect(manage).toBeVisible()
			await expect(card.getByRole('button', { name: /^install$/i })).toHaveCount(0)

			// The state is server-backed, not local: it survives a reload.
			await page.reload()
			const reloadedCard = page
				.getByRole('region', { name: 'Loops' })
				.locator('article')
				.filter({ has: page.getByRole('heading', { name: loopName ?? '', level: 3 }) })
			await expect(reloadedCard.getByText('Installed')).toBeVisible({ timeout: 20000 })
			await expect(reloadedCard.getByRole('link', MANAGE)).toBeVisible()

			// Detail page: the action bar sits above the scroll region, so the
			// breadcrumb, Manage and ⋯ are all on screen without scrolling.
			await reloadedCard.getByRole('link', { name: /^Open / }).click({ position: { x: 10, y: 10 } })
			await expect(page).toHaveURL(/\/marketplace\/[^/]+\/?$/)

			const detail = page.getByRole('main')
			const crumb = detail.getByRole('link', { name: 'Marketplace' })
			await expect(crumb).toBeVisible({ timeout: 20000 })
			const overflow = detail.getByRole('button', { name: 'Loop actions' })
			await expect(overflow).toBeVisible()
			await expect(detail.getByRole('link', MANAGE)).toBeVisible()

			const scrollY = await page.evaluate(() => window.scrollY)
			expect(scrollY).toBe(0)
			for (const control of [crumb, overflow]) {
				const box = await control.boundingBox()
				if (!box) throw new Error('missing action-bar bounding box')
				expect(box.y).toBeGreaterThanOrEqual(0)
				expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
			}

			// The detail header carries the plain "✓ Installed" affirmation.
			await expect(detail.getByText('Installed').first()).toBeVisible()

			// No horizontal overflow at any ship-gate viewport.
			const overflowPx = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflowPx).toBeLessThanOrEqual(1)

			// Remove from the ⋯ menu — it opens the confirmation dialog rather
			// than uninstalling on select — then confirm and check the catalog
			// card reverts.
			await overflow.click()
			await page.getByRole('menuitem', { name: 'Remove from workspace' }).click()
			const confirmDialog = page.getByRole('dialog')
			await expect(confirmDialog).toBeVisible()
			await confirmDialog.getByRole('button', { name: 'Remove' }).click()
			await expect(detail.getByRole('button', { name: /^install$/i })).toBeVisible({
				timeout: 20000,
			})

			await page.goto(`/${account.workspaceId}/marketplace`)
			const revertedCard = page
				.getByRole('region', { name: 'Loops' })
				.locator('article')
				.filter({ has: page.getByRole('heading', { name: loopName ?? '', level: 3 }) })
			await expect(revertedCard.getByRole('button', { name: /^install$/i })).toBeVisible({
				timeout: 20000,
			})
			await expect(revertedCard.getByText('Installed')).toHaveCount(0)
		})
	}

	test('the Installed marker and the flow rail stay legible in light and dark', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletPortrait.width,
			height: VIEWPORTS.tabletPortrait.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		const loopsSection = page.getByRole('region', { name: 'Loops' })
		await expect(loopsSection).toBeVisible({ timeout: 20000 })
		const card = loopsSection.locator('article').first()
		await card.getByRole('button', { name: /^install$/i }).click()
		await expect(card.getByText('Installed')).toBeVisible({ timeout: 20000 })

		await card.getByRole('link', { name: /^Open / }).click({ position: { x: 10, y: 10 } })
		const detail = page.getByRole('main')
		await expect(detail.getByText('The loop, once installed')).toBeVisible({ timeout: 20000 })

		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.evaluate((t) => localStorage.setItem('maskin-theme', t), scheme)
			await page.reload()

			const installedPill = detail.getByText('Installed').first()
			await expect(installedPill).toBeVisible({ timeout: 20000 })
			// Green-on-green, never a transparent pill that disappears.
			const pillBg = await installedPill.evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(pillBg).not.toBe('rgba(0, 0, 0, 0)')

			// The flow rail's dot is a text-free indicator — it must not be the
			// near-invisible `bg-accent` in light mode (known-pitfalls registry).
			const dot = detail.locator('ol li span.rounded-full').first()
			await expect(dot).toBeVisible()
			const dotBg = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(dotBg).not.toBe('rgba(0, 0, 0, 0)')

			await expect(detail.getByText('Permissions')).toBeVisible()
			await expect(detail.getByText('This workspace only')).toBeVisible()
		}

		// Leave the workspace as we found it.
		await page.emulateMedia({ colorScheme: 'light' })
		await detail.getByRole('button', { name: 'Loop actions' }).click()
		await page.getByRole('menuitem', { name: 'Remove from workspace' }).click()
		await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
		await expect(detail.getByRole('button', { name: /^install$/i })).toBeVisible({
			timeout: 20000,
		})
	})
})
