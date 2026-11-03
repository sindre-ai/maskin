import { expect, test } from '../fixtures/auth.fixture'
import { type NamedViewport, SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Regression pin for the object-page @ mention picker being clipped.
 *
 * Repro (Sebastian, #maskin-app): typing @ in the comment bar on an object
 * page shows no agent list; it only appears after scrolling to the bottom.
 * The bar is docked (sticky) to the bottom of the page scroller, so a list
 * that opens below it lands in the area the scroller clips.
 *
 * The comment bar uses the shared tag input, whose picker is a popover that
 * flips above the bar when there is no room below, and a bottom sheet on a
 * phone. The assertions are about the visible result, not class names: the
 * option is inside the viewport, on a computer it sits above the bar, and it
 * is the element a pointer would actually hit (a clipped list hit-tests to the
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
				status: 'opportunity',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			const composer = page.getByRole('textbox', { name: 'Comment' })
			await expect(composer).toBeVisible({ timeout: 10_000 })
			// Measured first: a phone's bottom sheet hides the page from the accessibility tree.
			const composerBox = await composer.boundingBox()
			await composer.click()
			await composer.pressSequentially('@')

			const option = page.getByRole('option', { name: new RegExp(agentName) })
			await expect(option).toBeVisible()

			const optionBox = await option.boundingBox()
			if (!composerBox || !optionBox) throw new Error('composer or option has no box')

			// Fully inside the viewport.
			expect(optionBox.x).toBeGreaterThanOrEqual(0)
			expect(optionBox.y).toBeGreaterThanOrEqual(0)
			expect(optionBox.x + optionBox.width).toBeLessThanOrEqual(vp.width)
			expect(optionBox.y + optionBox.height).toBeLessThanOrEqual(vp.height)

			// On a computer the list sits above the bar, not over it. A phone gets a
			// bottom sheet, which covers the bar by design.
			if (vp.width >= 768) {
				expect(optionBox.y + optionBox.height).toBeLessThanOrEqual(composerBox.y)
			}

			// A clipped list hit-tests to the scroller; a visible one hits the option.
			const hitsOption = await option.evaluate((el) => {
				const r = el.getBoundingClientRect()
				const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
				return hit !== null && el.contains(hit)
			})
			expect(hitsOption).toBe(true)
		})
	})
}
