import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Keychain settings pages. Mock-free: the paste form
 * drives the real POST /api/integrations/byo-apikey and the overview lists it as a card.
 * The value below is obviously fake and built at runtime so
 * no token-shaped literal sits in the repo.
 */
const FAKE_SECRET = `lin_${'CANARY0123'.repeat(4)}`

test.describe('Keychain settings', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`paste a key and see it listed as a card @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await page.goto(`/${account.workspaceId}/settings/keychain`)
			await expect(
				page.getByRole('heading', { name: 'One place for every credential your agents need' }),
			).toBeVisible({ timeout: 15_000 })

			// Keychain sits right under Integrations in the settings menu.
			const nav = page.getByRole('navigation', { name: 'Settings sections' })
			const labels = await nav.getByRole('link').allInnerTexts()
			expect(labels.indexOf('Keychain')).toBe(labels.indexOf('Integrations') + 1)

			await page.getByRole('link', { name: 'Add your first credential' }).click()
			await expect(page.getByRole('heading', { name: 'Add a credential' })).toBeVisible()

			const name = `Linear ${Date.now()}`
			const save = page.getByRole('button', { name: 'Save' })
			await expect(save).toBeDisabled()
			await page.getByLabel('Name').fill(name)
			await page.getByLabel('Secret').fill(FAKE_SECRET)
			await expect(page.getByLabel('Secret')).toHaveAttribute('type', 'password')
			await save.click()

			// Lands back on the overview, where the key is a card of its own.
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings/keychain$`), {
				timeout: 15_000,
			})
			await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 })
			await expect(page.getByText('API key', { exact: true })).toBeVisible()

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

			// With nothing spilling out sideways.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			)
			expect(overflow).toBe(false)
		})
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`add a login, then remove it and see it gone @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await page.goto(`/${account.workspaceId}/settings/keychain/new`)
			await expect(page.getByRole('heading', { name: 'Add a credential' })).toBeVisible({
				timeout: 15_000,
			})
			await page.getByRole('tab', { name: 'Login' }).click()

			const name = `e-conomic ${Date.now()}`
			await page.getByLabel('Name', { exact: true }).fill(name)
			await page.getByLabel('Username').fill('me@example.test')
			const password = page.getByLabel('Password')
			await expect(password).toHaveAttribute('type', 'password')
			await password.fill(FAKE_SECRET)
			await page.getByRole('button', { name: 'Save' }).click()

			// Lands on the overview, where it is a card typed as a Login.
			await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 })
			await expect(page.getByText('Login', { exact: true })).toBeVisible()

			// Removing asks first, and Cancel leaves it be.
			const remove = page.getByRole('button', { name: `Remove ${name}` })
			await expect(remove).toBeVisible()
			await remove.click()
			const dialog = page.getByRole('dialog')
			await expect(dialog).toContainText("can't be recovered")
			await dialog.getByRole('button', { name: 'Cancel' }).click()
			await expect(dialog).toHaveCount(0)
			await expect(page.getByText(name, { exact: true })).toBeVisible()

			// Confirming destroys it, and it is gone from the list.
			await remove.click()
			await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
			await expect(page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 15_000 })
		})
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`rename a key and replace its secret from the card @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await page.goto(`/${account.workspaceId}/settings/keychain/new`)
			const name = `Stripe ${Date.now()}`
			await page.getByLabel('Name').fill(name)
			await page.getByLabel('Secret').fill(FAKE_SECRET)
			await page.getByRole('button', { name: 'Save' }).click()
			await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 })

			await page.getByRole('button', { name: `Edit ${name}` }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByLabel('Name')).toHaveValue(name)
			// Nothing to save until something changes, and the current secret is never shown.
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
			await expect(dialog.getByLabel('New secret')).toHaveValue('')

			const renamed = `${name} live`
			await dialog.getByLabel('Name').fill(renamed)
			await dialog.getByLabel('New secret').fill(`${FAKE_SECRET}-v2`)
			await dialog.getByRole('button', { name: 'Save' }).click()
			await expect(dialog).toHaveCount(0, { timeout: 15_000 })

			await expect(page.getByText(renamed, { exact: true })).toBeVisible()
			await expect(page.getByText(name, { exact: true })).toHaveCount(0)
			// Neither value reaches the page or web storage.
			const leaked = await page.evaluate((secret) => {
				const dump = (st: Storage) =>
					Object.keys(st).some((k) => (st.getItem(k) ?? '').includes(secret))
				return {
					storage: dump(localStorage) || dump(sessionStorage),
					html: document.documentElement.innerHTML.includes(secret),
				}
			}, FAKE_SECRET)
			expect(leaked).toEqual({ storage: false, html: false })
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			)
			expect(overflow).toBe(false)
		})
	}

	test('renders the list in dark mode', async ({ page, account }) => {
		await page.addInitScript(() => {
			localStorage.setItem('maskin-theme', 'dark')
		})
		await page.goto(`/${account.workspaceId}/settings/keychain`)
		await expect(page.locator('html')).toHaveClass(/dark/, { timeout: 15_000 })
		await expect(
			page.getByRole('heading', { name: 'One place for every credential your agents need' }),
		).toBeVisible()
	})
})
