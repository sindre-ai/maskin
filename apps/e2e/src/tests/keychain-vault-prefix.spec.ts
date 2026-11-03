import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Vault mode, the ! prefix. Mock-free: the page talks to
 * the real backend and the spec watches the network. Typing or pasting ! plus a token in
 * the main chat composer and in a thread must send no message and create nothing, and
 * leave the token out of both web storages. The token is obviously fake and built at
 * runtime so no token-shaped literal sits in the repo.
 */
const FAKE_TOKEN = `Zq7${'K3x'.repeat(10)}`

/** Requests that would carry a message: a send into a thread, or a new chat with a first message. */
function watchMessageRequests(page: Page) {
	const seen: string[] = []
	page.on('request', (req) => {
		if (req.method() === 'POST' && /\/api\/conversations(\/|$)/.test(new URL(req.url()).pathname)) {
			seen.push(`${req.method()} ${new URL(req.url()).pathname}`)
		}
	})
	return seen
}

/** A real paste event, so the composer's own handler sees it. */
async function pasteInto(page: Page, text: string) {
	await page.getByLabel('Message this conversation').evaluate((el, value) => {
		const data = new DataTransfer()
		data.setData('text/plain', value)
		el.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
		)
	}, text)
}

async function storageHolds(page: Page, needle: string) {
	return page.evaluate((value) => {
		const dump = (s: Storage) => JSON.stringify(Object.fromEntries(Object.entries(s)))
		return dump(localStorage).includes(value) || dump(sessionStorage).includes(value)
	}, needle)
}

async function expectVaultModeHoldsTheToken(page: Page, requests: string[]) {
	const secret = page.getByLabel('Secret to vault')
	await expect(secret).toBeVisible()
	await expect(secret).toHaveAttribute('type', 'password')
	await expect(secret).toHaveAttribute('autocomplete', 'off')
	await expect(secret).toHaveAttribute('spellcheck', 'false')
	await expect(page.getByText('! Vault')).toBeVisible()
	// Not on the page, not in storage, and nothing sent.
	await expect(page.locator('body')).not.toContainText(FAKE_TOKEN)
	expect(await storageHolds(page, FAKE_TOKEN)).toBe(false)
	expect(requests).toEqual([])
}

test.describe('Vault mode (the ! prefix)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`paste ! plus a token in the main chat composer: no message, no storage @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const requests = watchMessageRequests(page)

			await page.goto(`/${account.workspaceId}/chats/new`)
			await page.getByLabel('Message this conversation').click()
			await pasteInto(page, `!${FAKE_TOKEN}`)

			await expectVaultModeHoldsTheToken(page, requests)
			// Enter in a filled field opens the scope step, which sends nothing either. With
			// no running session in a new chat there is nothing to vault into, so Vault waits.
			await expect(page.getByRole('button', { name: 'Vault →' })).toBeDisabled()
			await page.getByLabel('Secret to vault').press('Enter')
			await expect(page.getByText(/Assign scope for/)).toHaveCount(0)
			expect(requests).toEqual([])

			// Esc leaves vault mode, clears the field and never sends it.
			await page.getByLabel('Secret to vault').press('Escape')
			await expect(page.getByLabel('Secret to vault')).toHaveCount(0)
			await expect(page.getByLabel('Message this conversation')).toHaveText('')
			expect(await storageHolds(page, FAKE_TOKEN)).toBe(false)
			expect(requests).toEqual([])
		})

		test(`type ! and the token in a thread composer: no message, no storage @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Vault prefix ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'A conversation to type into',
			})
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const requests = watchMessageRequests(page)

			const composer = page.getByLabel('Message this conversation')
			await expect(composer).toBeVisible({ timeout: 15_000 })
			await composer.click()
			await composer.pressSequentially('!')
			const secret = page.getByLabel('Secret to vault')
			await expect(secret).toBeVisible()
			// Empty vault mode: Enter does nothing and never sends the bare prefix.
			await secret.press('Enter')
			expect(requests).toEqual([])

			await secret.fill(FAKE_TOKEN)
			await expectVaultModeHoldsTheToken(page, requests)

			// Backspace in the empty field removes the chip.
			await secret.fill('')
			await secret.press('Backspace')
			await expect(page.getByLabel('Secret to vault')).toHaveCount(0)
			await expect(page.getByLabel('Message this conversation')).toBeVisible()
			expect(requests).toEqual([])
		})
	}

	test('a leading space then ! is an ordinary message', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Plain bang ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'A conversation to type into',
		})
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const composer = page.getByLabel('Message this conversation')
		await expect(composer).toBeVisible({ timeout: 15_000 })
		await composer.click()
		await composer.pressSequentially(' !hello')
		await expect(page.getByLabel('Secret to vault')).toHaveCount(0)
		await expect(composer).toHaveText('!hello')
	})
})
