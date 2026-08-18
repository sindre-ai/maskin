import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T5 gate — status and driver changes made from the object-detail header must
// be still there after a full reload. Exercises the hero StatusSelect and
// OwnerSelect against real object data (bet under the test actor's workspace)
// with no mocks: the bet's acceptance criterion "status and driver changes
// persist on reload" only passes when the mutation reaches the API and the
// re-fetched object still carries the new values.

test.describe('Object detail — status + driver persist on reload', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`status change survives a full reload at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Persistence probe',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Persistence probe' })).toBeVisible({
				timeout: 15_000,
			})

			// Pick a new status via the hero Status select (Radix combobox, the
			// only one carrying the [data-hero-status-trigger] anchor).
			const statusTrigger = page.locator('[data-hero-status-trigger]')
			await expect(statusTrigger).toContainText('active')
			await statusTrigger.click()
			await page.getByRole('option', { name: 'succeeded' }).click()
			await expect(statusTrigger).toContainText('succeeded')

			await page.reload()
			await expect(page.getByRole('heading', { level: 1, name: 'Persistence probe' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.locator('[data-hero-status-trigger]')).toContainText('succeeded')
		})

		test(`driver change survives a full reload at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Driver persistence probe',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Driver persistence probe' }),
			).toBeVisible({ timeout: 15_000 })

			// OwnerSelect trigger starts on "Unassigned" for a freshly-created
			// object. The fixture actor gets a title-derived name that starts with
			// "E2E "; the workspace auto-adds them as owner, so they render as an
			// option in the driver menu.
			const driverTrigger = page
				.getByRole('combobox')
				.filter({ hasText: /driver/i })
				.first()
			await expect(driverTrigger).toContainText('Unassigned')
			await driverTrigger.click()
			const memberOption = page.getByRole('option').filter({ hasText: /^E2E / }).first()
			await expect(memberOption).toBeVisible()
			const memberName = (await memberOption.innerText()).trim()
			await memberOption.click()
			await expect(driverTrigger).toContainText(memberName)

			await page.reload()
			await expect(
				page.getByRole('heading', { level: 1, name: 'Driver persistence probe' }),
			).toBeVisible({ timeout: 15_000 })
			await expect(
				page
					.getByRole('combobox')
					.filter({ hasText: /driver/i })
					.first(),
			).toContainText(memberName)
		})
	}
})
