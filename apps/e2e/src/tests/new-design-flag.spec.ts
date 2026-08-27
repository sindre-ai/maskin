import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// `new-design` boundary gate. The v2 Objects, Search and Marketplace surfaces
// are flagged until they have been tested, so both branches must render. The
// auth fixture seeds the override on; these specs flip it off before boot to
// drive the pre-v2 branch, which is what an actor outside FF_TESTER_ACTOR_IDS
// gets today.
//
// Each surface has its own distinguishing marker: the object detail's tab strip
// (v2 renders Timeline / Related, the pre-v2 document renders neither), the
// search field's label, and the marketplace filter's placeholder.

test.describe('new-design flag — off renders the pre-v2 surfaces', () => {
	// Depends on `account` on purpose: init scripts run in registration order,
	// and a fixture requested only by the test body is instantiated *after* the
	// hooks. Without this the auth fixture's `ff:new-design = 'on'` would
	// register last and win, silently running these specs on the v2 branch.
	test.beforeEach(async ({ page, account }) => {
		expect(account.workspaceId).toBeTruthy()
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

			// The pre-v2 document edits its title in place, so the title is a
			// textarea named by its placeholder — not the v2 shell's static h1.
			await expect(page.getByRole('textbox', { name: 'Untitled' })).toHaveValue('Flag-off bet', {
				timeout: 10000,
			})
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
		// Status groups rest collapsed, so leaf titles are not rendered until the
		// group holding the seeded bet is opened.
		await page.getByRole('button', { name: /^active \d+$/ }).click()
		await page.getByText('Flag-off list bet').first().click()
		await expect(page).toHaveURL(new RegExp(`/objects/${bet.id}`))
		await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0)
	})

	test('search falls back to the pre-v2 view', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/search`)

		// The pre-v2 view has a single unfiltered input; v2 adds a back button,
		// group/type/status filters, and a differently-labelled field.
		await expect(page.getByRole('textbox', { name: 'Search the workspace' })).toBeVisible({
			timeout: 10000,
		})
		await expect(page.getByRole('textbox', { name: 'Search', exact: true })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Filter by group' })).toHaveCount(0)
	})

	test('marketplace falls back to the pre-v2 catalogue and detail page', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/marketplace`)

		const filter = page.getByRole('searchbox', { name: 'Filter marketplace' })
		await expect(filter).toHaveAttribute('placeholder', 'Search the marketplace…', {
			timeout: 10000,
		})

		const loopsSection = page.getByRole('region', { name: 'Loops' })
		await expect(loopsSection).toBeVisible()
		await loopsSection
			.getByRole('link')
			.first()
			.click({ position: { x: 10, y: 10 } })

		await expect(page).toHaveURL(/\/marketplace\/[^/]+$/)
		// v2-only sections on the loop detail page — absent on the pre-v2 branch.
		await expect(page.getByText('The loop, once installed')).toHaveCount(0)
		await expect(page.getByText('How it runs')).toHaveCount(0)
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
