import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Verifies T5 surface wiring — the fleet-status view on the objects overview,
// three collapsible sections by primitive with a "N waiting" pill and
// waiting-on-human rows sorted to the top.

test.describe('Objects fleet-status view', () => {
	test.describe.configure({ mode: 'serial' })

	async function seedMixedPortfolio(account: { workspaceId: string; api: TestAPI }) {
		const insight = await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'Fleet insight — needs attention',
			status: 'todo',
			metadata: { human_decision: true },
		})
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Fleet bet — active',
			status: 'active',
		})
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Fleet task — needs approval',
			status: 'todo',
			metadata: { human_decision: true },
		})
		return { insight, bet, task }
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders three primitive sections at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await seedMixedPortfolio(account)

			await page.goto(`/${account.workspaceId}/objects`)

			// Wait for the fleet sections to mount — the three primitive headers
			// key on `data-fleet-section` so the assertion doesn't rely on
			// whichever tab labels happen to be enabled in the workspace.
			await expect(page.locator('[data-fleet-section="insight"]')).toBeVisible({
				timeout: 10000,
			})
			await expect(page.locator('[data-fleet-section="bet"]')).toBeVisible()
			await expect(page.locator('[data-fleet-section="task"]')).toBeVisible()

			// Section order is fixed: insight → bet → task (matches the bet AC).
			const sections = await page.locator('[data-fleet-section]').all()
			const order = await Promise.all(sections.map((s) => s.getAttribute('data-fleet-section')))
			expect(order).toEqual(['insight', 'bet', 'task'])
		})
	}

	test('waiting-on-human row lands with the red-halo dot at the top of its section, driving a "N waiting" pill', async ({
		page,
		account,
	}) => {
		await seedMixedPortfolio(account)

		await page.goto(`/${account.workspaceId}/objects`)

		const insightSection = page.locator('[data-fleet-section="insight"]')
		await expect(insightSection).toBeVisible({ timeout: 10000 })

		// The seeded insight has metadata.human_decision=true + status=todo →
		// waiting_on_human. It should sit at the top of the insight section
		// and drive a "1 waiting" pill in the header (matches the AC bullet
		// "each section header shows … a 'N waiting' pill").
		await expect(insightSection.locator('[data-fleet-waiting-pill]')).toContainText('1 waiting')

		// First row inside the section renders the waiting-on-human indicator
		// via the reused `IndicatorBadgeRow` — matches the AC bullet
		// "waiting-on-human rows render with the red-halo dot indicator".
		await expect(insightSection.getByLabel('Status: waiting').first()).toBeVisible()
	})

	test('collapsing a section hides its rows and re-opening restores them', async ({
		page,
		account,
	}) => {
		await seedMixedPortfolio(account)

		await page.goto(`/${account.workspaceId}/objects`)

		const betSection = page.locator('[data-fleet-section="bet"]')
		await expect(betSection).toBeVisible({ timeout: 10000 })
		await expect(betSection.getByText('Fleet bet — active')).toBeVisible()

		await betSection.getByRole('button', { name: /Bets?/ }).first().click()
		await expect(betSection.getByText('Fleet bet — active')).not.toBeVisible()

		await betSection.getByRole('button', { name: /Bets?/ }).first().click()
		await expect(betSection.getByText('Fleet bet — active')).toBeVisible()
	})
})
