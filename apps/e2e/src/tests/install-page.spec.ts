import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The page a public maskin.io loop page sends people to: /install/<loop slug>. The dev bootstrap seeds the two
// installable loops, so both slugs resolve.

const SLUG = 'market-competitor-watch-loop'

test.describe('Install a flow from one short page', () => {
	test('a signed-out visitor is sent to sign-in with this page as the return path', async ({
		browser,
	}) => {
		const context = await browser.newContext()
		const page = await context.newPage()
		await page.goto(`/install/${SLUG}`)

		await expect(page).toHaveURL(/\/login\?redirect=%2Finstall%2Fmarket-competitor-watch-loop/)
		// Sign-up keeps the return path, so a new account also comes back here.
		await page.getByRole('link', { name: 'Sign up' }).click()
		await expect(page).toHaveURL(/\/signup\?redirect=%2Finstall%2Fmarket-competitor-watch-loop/)
		await context.close()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`signed in: shows the loop, installs once and opens Manage at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/install/${SLUG}`)

			await expect(page.getByText(account.workspaceName)).toBeVisible({ timeout: 20000 })
			const install = page.getByRole('button', { name: 'Install', exact: true })
			await expect(install).toBeVisible()

			// The page never scrolls sideways.
			const overflowPx = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflowPx).toBeLessThanOrEqual(1)

			await install.click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/loops/[0-9a-f-]{36}`), {
				timeout: 30000,
			})

			// Back on the install page the loop is there already: no second install.
			await page.goto(`/install/${SLUG}`)
			await expect(page.getByText('Already installed')).toBeVisible({ timeout: 20000 })
			await expect(install).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Manage' })).toBeVisible()
		})
	}

	test('an unknown loop shows a not-found message with a link to the public marketplace', async ({
		page,
		account: _account,
	}) => {
		await page.goto('/install/no-such-loop')

		await expect(page.getByText("We couldn't find that flow")).toBeVisible({ timeout: 20000 })
		await expect(page.getByRole('link', { name: 'See all flows' })).toHaveAttribute(
			'href',
			'https://maskin.io/marketplace/',
		)
	})
})
