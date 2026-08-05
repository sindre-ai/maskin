import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// AC-U5: the bet detail page leads with hypothesis + activity timeline; properties
// and files live in a right sidebar — an overlay Sheet below 768px (closed by
// default), and an inline docked panel at 768px+ (collapsed rail @768, expanded
// @1024 by default — see breakpointDefaultOpen in object-document.tsx). This spec
// drives the toggle at 375/768/1024 to confirm the sidebar opens per viewport and
// the Properties + Files sections are reachable.

test.describe('Bet detail — properties drawer', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`hypothesis + drawer toggle work at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drawer parity bet',
				content:
					'Hypothesis: operators read state from description + timeline alone.\n\nThis is the body.',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			// Title lives in a textarea (object-document.tsx). Wait for it to hydrate
			// before probing the drawer.
			await expect(page.locator('textarea').first()).toHaveValue('Drawer parity bet', {
				timeout: 10000,
			})

			// Body shows hypothesis text.
			await expect(
				page.getByText('Hypothesis: operators read state from description + timeline alone.'),
			).toBeVisible()

			// The sidebar's own collapse toggle also has an accessible name
			// containing "Properties" ("Expand/Collapse properties"), so this must
			// be an exact match to avoid a strict-mode violation.
			const toggle = page.getByRole('button', { name: 'Properties', exact: true })

			if (viewport.width < 768) {
				// Below 768px the sidebar renders as an overlay Sheet — closed by
				// default, opened via the header toggle, closed via Escape.
				await expect(page.getByRole('dialog')).toHaveCount(0)

				await toggle.click()

				const drawer = page.getByRole('dialog')
				await expect(drawer).toBeVisible()
				await expect(drawer.getByText('Properties', { exact: true })).toBeVisible()
				await expect(drawer.getByText(/Files \(/)).toBeVisible()

				await page.keyboard.press('Escape')
				await expect(page.getByRole('dialog')).toHaveCount(0)
			} else {
				// At 768px+ the sidebar docks inline and is never a modal dialog —
				// open it via the toggle if the breakpoint default left it collapsed.
				await expect(page.getByRole('dialog')).toHaveCount(0)

				if ((await toggle.getAttribute('aria-expanded')) === 'false') {
					await toggle.click()
				}
				await expect(toggle).toHaveAttribute('aria-expanded', 'true')
				await expect(page.getByText('Properties', { exact: true })).toBeVisible()
				await expect(page.getByRole('heading', { name: /^Files \(/ })).toBeVisible()
				await expect(page.getByRole('dialog')).toHaveCount(0)
			}
		})
	}
})
