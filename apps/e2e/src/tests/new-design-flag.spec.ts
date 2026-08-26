import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// `new-design` boundary gate. The v2 Objects surfaces are flagged until they
// have been tested, so both branches must render. The auth fixture seeds the
// override on; these specs flip it off before boot to drive the pre-v2 branch,
// which is what an actor outside FF_TESTER_ACTOR_IDS gets today.
//
// The distinguishing marker is the detail surface's tab strip: v2 renders
// Timeline / Related tabs, the pre-v2 document renders neither.

test.describe('new-design flag — off renders the pre-v2 Objects surfaces', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:new-design', 'off'))
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`object detail falls back to the pre-v2 document at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Flag-off bet',
				status: 'active',
				content: '## Context\n\nParagraph of context.',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			await expect(page.getByRole('heading', { name: 'Flag-off bet' })).toBeVisible()
			await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0)
			await expect(page.getByRole('tab', { name: /^Related/ })).toHaveCount(0)

			// No horizontal overflow on the fallback branch either.
			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflows).toBe(false)
		})
	}

	test('objects list renders and navigates on the pre-v2 branch', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Flag-off list bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects`)
		await page.getByText('Flag-off list bet').first().click()
		await expect(page).toHaveURL(new RegExp(`/objects/${bet.id}`))
		await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0)
	})
})

test.describe('new-design flag — on renders the v2 Objects surfaces', () => {
	test('object detail shows the v2 tab strip', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Flag-on bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible()
	})
})
