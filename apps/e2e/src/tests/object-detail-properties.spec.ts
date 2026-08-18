import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v2 Object detail gate (mockup 1029–1502). The page bar carries the
// breadcrumb, a Properties toggle and the overflow menu; the drawer it opens
// holds driver / status / custom fields / subscribed / files. Below the
// document, one Activity heading with a Timeline | Related segmented control,
// and a composer pinned to the bottom of the scroll region.

test.describe('Object detail — properties drawer', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`toggle opens the properties drawer at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drawer bet',
				status: 'active',
				metadata: { priority: 'high' },
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Drawer bet' })).toBeVisible({
				timeout: 15000,
			})

			const toggle = page.getByRole('button', { name: 'Properties' })
			await expect(toggle).toBeVisible()
			await expect(toggle).toHaveAttribute('aria-expanded', 'false')

			await toggle.click()
			await expect(toggle).toHaveAttribute('aria-expanded', 'true')

			// The drawer's own sections (mockup 1381–1499).
			await expect(page.getByText('driver')).toBeVisible()
			await expect(page.getByText('Custom fields')).toBeVisible()
			await expect(page.getByText('Subscribed')).toBeVisible()

			// No horizontal page scroll with the drawer open.
			const scrollWidth = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(scrollWidth).toBeLessThanOrEqual(0)
		})

		test(`segmented control switches Timeline ⇄ Related at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Segmented bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Segmented bet' })).toBeVisible({
				timeout: 15000,
			})

			// One Activity heading, and exactly two tabs — the third "Activity"
			// tab folded into the merged stream (mockup 1138–1143).
			await expect(page.getByText('Activity', { exact: true })).toBeVisible()
			const tabs = page.getByRole('tab')
			await expect(tabs).toHaveCount(2)

			const timeline = page.getByRole('tab', { name: /^Timeline$/ })
			await expect(timeline).toHaveAttribute('aria-selected', 'true')
			// The stream's own filter chips carry per-kind counts.
			await expect(page.getByRole('button', { name: /^All \(\d+\)$/ })).toBeVisible()

			await page.getByRole('tab', { name: /^Related/ }).click()
			await expect(page.getByRole('tab', { name: /^Related/ })).toHaveAttribute(
				'aria-selected',
				'true',
			)
			await expect(page.getByText('No related objects yet.')).toBeVisible()

			await timeline.click()
			await expect(timeline).toHaveAttribute('aria-selected', 'true')
		})

		test(`composer stays pinned to the bottom while the document scrolls at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Sticky composer bet',
				status: 'active',
				content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of long content.`).join(
					'\n\n',
				),
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const composer = page.getByPlaceholder(/write a comment/i)
			await expect(composer).toBeVisible({ timeout: 15000 })

			await page.mouse.move(vp.width / 2, vp.height / 2)
			await page.mouse.wheel(0, 1200)
			await page.waitForTimeout(300)

			await expect(composer).toBeVisible()
		})
	}
})
