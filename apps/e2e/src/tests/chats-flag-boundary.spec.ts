import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The `new-design` boundary for the Chats surface. `chats-v2.spec.ts` covers the
 * flag-ON surface (the auth fixture seeds `ff:new-design = 'on'`); this spec
 * asserts that with the flag OFF the pre-v2 Chats surface still renders and none
 * of the v2 affordances leak into it.
 *
 * The `ff:<flagId>` localStorage override is the test-only mechanism documented
 * in `.claude/rules/feature-flags.md`.
 */

async function setFlagOff(page: import('@playwright/test').Page) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:new-design', 'off')
	})
}

test.describe('Chats — new-design boundary', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the pre-v2 chats surface with the flag off at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const convo = await account.api.createConversation(account.workspaceId, {
				title: `Flag off ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'A pre-v2 conversation',
			})
			await setFlagOff(page)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats`)

			// The legacy list still lists conversations…
			await expect(page.locator('[data-shell="v1"]')).toBeVisible()
			await expect(page.getByText(convo.title)).toBeVisible()
			// …and none of the v2 chrome is mounted.
			await expect(page.getByRole('button', { name: /^Filter conversations/ })).toHaveCount(0)

			// The legacy thread pane opens and shows the seeded message.
			await page.getByText(convo.title).click()
			await expect(page.getByText('A pre-v2 conversation')).toBeVisible()
		})
	}

	test('renders the pre-v2 new-chat page with the flag off', async ({ page, account }) => {
		await setFlagOff(page)
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/chats/new`)

		await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
		// v2's zero state and its suggestion list must not appear.
		await expect(page.getByText('What are we working on?')).toHaveCount(0)
		await expect(page.getByText('Catch me up on billing')).toHaveCount(0)
	})

	test('renders the v2 chats surface with the flag on', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/chats`)

		await expect(page.locator('[data-shell="v2"]')).toBeVisible()
		await expect(page.getByRole('button', { name: /^Filter conversations/ })).toBeVisible()
	})
})
