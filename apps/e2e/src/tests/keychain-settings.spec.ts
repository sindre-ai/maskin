import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Keychain settings pages (flag: keychain-settings-ui). Mock-free: the paste form
 * drives the real POST /api/integrations/byo-apikey and the detail page reads the
 * real audit-log route. The value below is obviously fake and built at runtime so
 * no token-shaped literal sits in the repo.
 */
const FAKE_SECRET = `lin_${'CANARY0123'.repeat(4)}`

test.describe('Keychain settings', () => {
	test('is not found, and not in the nav, while the flag is off', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/settings/keychain`)
		await expect(page.getByText('Page not found')).toBeVisible({ timeout: 15_000 })
		await expect(
			page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
				name: 'Keychain',
			}),
		).toHaveCount(0)
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`paste a key, see it listed and read its audit log @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.addInitScript(() => {
				localStorage.setItem('ff:keychain-settings-ui', 'on')
			})

			await page.goto(`/${account.workspaceId}/settings/keychain`)
			await expect(
				page.getByRole('heading', { name: 'One place for every credential your agents need' }),
			).toBeVisible({ timeout: 15_000 })

			await page.getByRole('link', { name: 'Add your first credential' }).click()
			await expect(page.getByRole('heading', { name: 'Add a credential' })).toBeVisible()
			// Chat capture is a link to chats; OAuth is not selectable.
			await expect(page.getByRole('link', { name: /Capture from a chat/ })).toBeVisible()

			const name = `Linear ${Date.now()}`
			const save = page.getByRole('button', { name: 'Save' })
			await expect(save).toBeDisabled()
			await page.getByLabel('Name').fill(name)
			await page.getByLabel('Secret').fill(FAKE_SECRET)
			await expect(page.getByLabel('Secret')).toHaveAttribute('type', 'password')
			await save.click()

			// Lands on the new credential, whose audit log starts with its create row.
			await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 })
			const log = page.getByRole('region', { name: 'Audit log' })
			await expect(log).toContainText('added this credential')
			await expect(log).toContainText('CREATE')
			await expect(page.getByRole('region', { name: 'Details' })).toContainText('API key')

			// The value never reaches either web storage or the rendered page.
			const leaked = await page.evaluate((secret) => {
				const dump = (s: Storage) =>
					Object.keys(s).some((k) => (s.getItem(k) ?? '').includes(secret))
				return {
					storage: dump(localStorage) || dump(sessionStorage),
					html: document.documentElement.innerHTML.includes(secret),
				}
			}, FAKE_SECRET)
			expect(leaked).toEqual({ storage: false, html: false })

			// And the list shows it, with nothing spilling out sideways.
			await page.getByRole('link', { name: 'Keychain', exact: true }).first().click()
			await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible()
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			)
			expect(overflow).toBe(false)
		})
	}

	test('renders the list in dark mode', async ({ page, account }) => {
		await page.addInitScript(() => {
			localStorage.setItem('ff:keychain-settings-ui', 'on')
			localStorage.setItem('maskin-theme', 'dark')
		})
		await page.goto(`/${account.workspaceId}/settings/keychain`)
		await expect(page.locator('html')).toHaveClass(/dark/, { timeout: 15_000 })
		await expect(
			page.getByRole('heading', { name: 'One place for every credential your agents need' }),
		).toBeVisible()
	})
})
