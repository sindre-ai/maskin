import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The first example sentence on the "New loop" page.
const EXAMPLE_CHIP = /When a customer reports a bug in Slack/i

test.describe('New loop — language hands off to the Chief of Staff', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`describing a loop opens a conversation with the Chief of Staff at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			// Nothing on this screen writes a loop — the loop is built in the chat
			// the sentence opens, not here.
			const loopsBefore = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)

			await page.goto(`/${account.workspaceId}/loops/new`)

			await expect(page.getByRole('heading', { name: 'What should the loop do?' })).toBeVisible({
				timeout: 10000,
			})
			// The three primitives a loop is made of are named before you speak.
			await expect(page.getByText('OBJECT TYPE')).toBeVisible()
			await expect(page.getByText('TRIGGER', { exact: true })).toBeVisible()
			await expect(page.getByText('AGENT', { exact: true })).toBeVisible()

			const composer = page.getByRole('textbox', { name: /describe your loop/i })
			await composer.fill('Chase every unpaid invoice for me, and tell me before anything is sent')
			await composer.press('Enter')

			// It lands in the conversation itself, with the sentence already sent.
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/chats/[0-9a-f-]{36}`), {
				timeout: 15000,
			})
			await expect(
				page.getByText('Chase every unpaid invoice for me, and tell me before anything is sent'),
			).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Chief of Staff').first()).toBeVisible()

			// Still no loop object — the screen created a conversation, not a loop.
			const loopsAfter = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)
			expect(loopsAfter.length).toBe(loopsBefore.length)
		})

		test(`an example sentence starts the same conversation at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops/new`)
			await expect(page.getByRole('button', { name: EXAMPLE_CHIP })).toBeVisible({ timeout: 10000 })

			await page.getByRole('button', { name: EXAMPLE_CHIP }).click()

			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/chats/[0-9a-f-]{36}`), {
				timeout: 15000,
			})
			await expect(page.getByText(/When a customer reports a bug in Slack/i).first()).toBeVisible({
				timeout: 10000,
			})
		})
	}
})
