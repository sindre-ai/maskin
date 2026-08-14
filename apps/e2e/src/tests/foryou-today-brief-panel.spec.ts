import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T2 of bet foryou-prototype-redesign — the side rail + Sheet "Today's brief"
// panel was deleted from the single-card queue redesign. The button now
// navigates straight to the real /briefing route instead of toggling a
// placeholder panel.

test.describe("For You — Today's brief button", () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`navigates to the briefing route at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)

			const trigger = page.getByRole('button', { name: /today.?s brief/i })
			await expect(trigger).toBeVisible({ timeout: 10000 })
			await trigger.click()

			await page.waitForURL(`**/${account.workspaceId}/briefing`)
			// exact: true — the briefing markdown body renders its own H1
			// ("{workspace name} — workspace briefing"), which substring-matches
			// the default (non-exact) name filter on "Briefing".
			await expect(
				page.getByRole('heading', { name: 'Briefing', exact: true, level: 1 }),
			).toBeVisible()
		})
	}
})
