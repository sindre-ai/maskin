import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Custom webhook extensions (bring-your-own integrations). The surface sits
 * behind the byo-extensions-ui flag; nothing sets FF_TESTER_FEATURES in CI, so
 * the specs use the client-side test override. The backend is real: the
 * extension, its encrypted secret and the delivery rows all go through
 * /api/extensions and POST /api/webhooks/x/:token.
 */

const FLAG_KEY = 'ff:byo-extensions-ui'

async function setFlag(page: Page, value: 'on' | 'off') {
	await page.addInitScript(
		({ key, v }) => {
			localStorage.setItem(key, v)
		},
		{ key: FLAG_KEY, v: value },
	)
}

function signedFireflies(secret: string, meetingId: string) {
	const body = JSON.stringify({
		event: 'meeting.transcribed',
		timestamp: 1760000000000,
		meeting_id: meetingId,
	})
	const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
	return { body, signature }
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`custom webhook extension at ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('adds an extension, reveals the URL and secret once, and shows a committed delivery', async ({
			page,
			account,
		}) => {
			await setFlag(page, 'on')
			const name = `Fireflies ${Date.now()}`

			await page.goto(`/${account.workspaceId}/settings/extensions`)
			await page.getByRole('button', { name: 'Add extension' }).first().click()
			await page.getByLabel('Name').fill(name)
			await page.getByRole('button', { name: 'Continue' }).click()
			await expect(page).toHaveURL(/\/settings\/extensions\/[0-9a-f-]{36}$/)
			await expect(page.getByRole('heading', { name })).toBeVisible()
			await expect(page.getByText('Waiting for first delivery')).toBeVisible()

			// Recipe pre-fills the Fireflies config; Generate fills the secret (ruling R2).
			await page.getByLabel('Start from a recipe').click()
			await page.getByRole('option', { name: 'Fireflies' }).click()
			await expect(page.getByLabel('Signature header')).toHaveValue('X-Hub-Signature')
			await expect(page.getByLabel('External ID (dedup key)')).toHaveValue('$.meeting_id')
			await page.getByRole('button', { name: 'Generate one' }).click()
			await expect(page.getByLabel('Signing secret')).toHaveValue(/^[0-9a-f]{64}$/)
			const secret = await page.getByLabel('Signing secret').inputValue()

			// Dry run writes nothing but names the event the sample would create.
			await page
				.getByRole('textbox', { name: 'Sample payload' })
				.fill(JSON.stringify({ event: 'meeting.transcribed', meeting_id: 'sample-1' }))
			await page.getByRole('button', { name: 'Run sample' }).click()
			await expect(page.getByText('This delivery would create an event')).toBeVisible()

			await page.getByRole('button', { name: 'Save + generate URL' }).click()

			// Reveal-once: Escape does not dismiss it, the primary button does.
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText(`Paste these into ${name}`)).toBeVisible()
			await expect(
				dialog.getByText("You won't see the secret again after this dialog closes."),
			).toBeVisible()
			await expect(dialog.getByText(secret)).toBeVisible()
			const webhookUrl = (await dialog.locator('#reveal-webhook-url').textContent()) ?? ''
			expect(webhookUrl).toMatch(/\/api\/webhooks\/x\/[A-Za-z0-9_-]{43}$/)
			await page.keyboard.press('Escape')
			await expect(dialog).toBeVisible()
			await dialog.getByRole('button', { name: `I've saved them in ${name}` }).click()
			await expect(dialog).toBeHidden()

			// After close: full URL stays, the secret is masked and never shown again.
			await expect(page.getByText(webhookUrl)).toBeVisible()
			await expect(page.getByText(secret)).toHaveCount(0)
			await expect(page.getByLabel('Signing secret (hidden)')).toBeVisible()

			// A signed delivery turns the checklist from waiting to receiving.
			const path = new URL(webhookUrl).pathname
			const delivery = signedFireflies(secret, 'e2e-meeting-1')
			const post = () =>
				page.request.post(path, {
					data: delivery.body,
					headers: { 'content-type': 'application/json', 'x-hub-signature': delivery.signature },
				})
			const first = await post()
			expect(first.status()).toBe(200)
			expect(await first.json()).toMatchObject({ status: 'committed' })
			await expect(page.getByText('Receiving', { exact: true })).toBeVisible({ timeout: 20_000 })
			await expect(page.getByRole('cell', { name: 'e2e-meeting-1' })).toBeVisible()
			await expect(page.getByText('Committed', { exact: true })).toBeVisible()

			// A repeat is a duplicate and adds no row.
			const repeat = await post()
			expect(await repeat.json()).toMatchObject({ status: 'duplicate' })
			await expect(page.getByText('Last 14 days, 1 committed')).toBeVisible()
		})

		test('shows field errors instead of saving an empty webhook', async ({ page, account }) => {
			await setFlag(page, 'on')
			await page.goto(`/${account.workspaceId}/settings/extensions`)
			await page.getByRole('button', { name: 'Add extension' }).first().click()
			await page.getByLabel('Name').fill(`Empty ${Date.now()}`)
			await page.getByRole('button', { name: 'Continue' }).click()
			await page.getByRole('button', { name: 'Save + generate URL' }).click()
			await expect(page.getByText('Use at least 16 characters, or press Generate')).toBeVisible()
			await expect(page.getByText('Required').first()).toBeVisible()
			await expect(page.getByRole('dialog')).toHaveCount(0)
		})
	})
}

test.describe('custom webhook extension flag', () => {
	test('hides the custom section and the detail page while the flag is off', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'off')
		await page.goto(`/${account.workspaceId}/settings/extensions`)
		await expect(page.getByRole('switch', { name: 'Work' })).toBeVisible()
		await expect(page.getByRole('heading', { name: 'Custom' })).toHaveCount(0)
		await page.goto(
			`/${account.workspaceId}/settings/extensions/00000000-0000-4000-8000-000000000000`,
		)
		await expect(page.getByText('Page not found')).toBeVisible()
	})

	test('renders in dark mode', async ({ page, account }) => {
		await setFlag(page, 'on')
		await page.goto(`/${account.workspaceId}/settings/extensions`)
		await page.evaluate(() => document.documentElement.classList.add('dark'))
		await expect(page.getByRole('heading', { name: 'Custom' })).toBeVisible()
		await expect(page.getByRole('button', { name: 'Add extension' }).first()).toBeVisible()
	})
})
