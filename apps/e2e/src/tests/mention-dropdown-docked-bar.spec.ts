import { expect, test } from '../fixtures/auth.fixture'
import { type NamedViewport, SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Regression pin for the object-page @ mention dropdown being clipped.
 *
 * Repro (Sebastian, #maskin-app): typing @ in the comment bar on an object
 * page shows no agent list; it only appears after scrolling to the bottom.
 * The bar is docked (sticky) to the bottom of the page scroller, so a list
 * that opens below it lands in the area the scroller clips.
 *
 * The fix passes mentionDropdownPlacement="above" at that one mount. The
 * assertions below are about the visible result, not class names: the list
 * sits above the bar, inside the viewport, and the last option is the
 * element a pointer would actually hit (a clipped list hit-tests to the
 * scroller instead).
 */

// The clip is easiest to see on a short window (about 557px tall on main), so
// run one extra short case on top of the ship-gate sizes.
const SHORT_VIEWPORT: NamedViewport = { width: 1050, height: 557, label: 'Short (1050×557)' }

for (const vp of [...SHIP_GATE_VIEWPORTS, SHORT_VIEWPORT]) {
	test.describe(`@ mention dropdown on the docked comment bar at ${vp.label}`, () => {
		test('opens above the bar, fully visible, and the last option is hit-testable', async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agentName = `E2E Mention Agent ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'E2E mention dropdown bet',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			// The placeholder is "Comment…" on mobile and a longer form on
			// desktop, so match only the shared prefix.
			const composer = page.getByRole('textbox', { name: /Comment/ })
			await expect(composer).toBeVisible({ timeout: 10_000 })
			await composer.click()
			await composer.pressSequentially('@')

			const firstOption = page.getByRole('button', { name: agentName })
			await expect(firstOption).toBeVisible()
			const dropdown = firstOption.locator('xpath=..')
			const lastOption = dropdown.getByRole('button').last()

			const composerBox = await composer.boundingBox()
			const dropdownBox = await dropdown.boundingBox()
			if (!composerBox || !dropdownBox) throw new Error('composer or dropdown has no box')

			// Fully inside the viewport.
			expect(dropdownBox.x).toBeGreaterThanOrEqual(0)
			expect(dropdownBox.y).toBeGreaterThanOrEqual(0)
			expect(dropdownBox.x + dropdownBox.width).toBeLessThanOrEqual(vp.width)
			expect(dropdownBox.y + dropdownBox.height).toBeLessThanOrEqual(vp.height)

			// Sits above the composer, not below it.
			expect(dropdownBox.y + dropdownBox.height).toBeLessThanOrEqual(composerBox.y)

			// A clipped list hit-tests to the scroller; a visible one hits the option.
			const hitsLastOption = await lastOption.evaluate((el) => {
				const r = el.getBoundingClientRect()
				const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
				return hit !== null && el.contains(hit)
			})
			expect(hitsLastOption).toBe(true)
		})
	})
}
