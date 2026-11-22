import { expect, test } from '../fixtures/auth.fixture'
import { openDiscover } from '../helpers/integrations.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The paste form for a tool whose vendor lets only the customer's own admin create the sign-in app
 * (Salesforce). Salesforce is behind a tester flag the e2e actor does not have, so the provider
 * list and the two app calls are stubbed. The backend half (the secret stored as an envelope, the
 * workspace's own app on the sign-in URL, another workspace's app never read) is covered against
 * real Postgres in apps/dev's oauth-app integration test.
 */
const SALESFORCE = {
	name: 'salesforce',
	displayName: 'Salesforce',
	authType: 'oauth2',
	events: [],
	customerApp: true,
}
const CALLBACK = 'https://api.example.com/api/integrations/salesforce/callback'

async function stubSalesforce(page: import('@playwright/test').Page, saved: { value: boolean }) {
	await page.route(
		(url) => url.pathname === '/api/integrations/providers',
		async (route) => {
			const response = await route.fetch()
			const providers = (await response.json()) as unknown[]
			await route.fulfill({ response, json: [...providers, SALESFORCE] })
		},
	)
	const puts: unknown[] = []
	await page.route(
		(url) => url.pathname === '/api/integrations/salesforce/app',
		async (route) => {
			if (route.request().method() === 'PUT') {
				puts.push(route.request().postDataJSON())
				saved.value = true
			}
			await route.fulfill({
				json: {
					configured: saved.value,
					clientId: saved.value ? '3MVG9abc' : undefined,
					callbackUrl: CALLBACK,
				},
			})
		},
	)
	// The sign-in itself leaves for Salesforce: answer with a page of ours so the run stays offline.
	let connected = false
	await page.route(
		(url) => url.pathname === '/api/integrations/salesforce/connect',
		async (route) => {
			connected = true
			await route.fulfill({ json: { install_url: '/signed-in-at-salesforce' } })
		},
	)
	return { puts, wasConnected: () => connected }
}

test.describe('Settings — Integrations own sign-in app form', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Connect asks for the app id and secret, saves them, then signs in at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const saved = { value: false }
			const stub = await stubSalesforce(page, saved)
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await openDiscover(page)
			await page.getByPlaceholder(/Search integrations/).fill('Salesforce')

			await page.getByRole('button', { name: 'Connect' }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Connect Salesforce')).toBeVisible()
			// The callback the customer's app must list is shown and copyable.
			await expect(dialog.getByLabel('Callback URL to give the app')).toHaveValue(CALLBACK)
			const save = dialog.getByRole('button', { name: 'Save and connect' })
			await expect(save).toBeDisabled()

			await dialog.getByLabel('App ID').fill('3MVG9abc')
			const secret = dialog.getByLabel('App secret')
			await secret.fill('not-a-real-secret')
			// Typed into a password field, so it is never on screen.
			await expect(secret).toHaveAttribute('type', 'password')
			expect(stub.wasConnected()).toBe(false)

			await save.click()
			await expect
				.poll(() => stub.puts)
				.toEqual([{ clientId: '3MVG9abc', clientSecret: 'not-a-real-secret' }])
			await expect.poll(() => stub.wasConnected()).toBe(true)
		})

		test(`a saved app is changed from a link under the name, never shown back at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await stubSalesforce(page, { value: true })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await openDiscover(page)
			await page.getByPlaceholder(/Search integrations/).fill('Salesforce')

			await page.getByRole('button', { name: 'Change app' }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Change the Salesforce app')).toBeVisible()
			await expect(dialog.getByLabel('App secret')).toHaveValue('')
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
		})
	}
})
