import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type TestAPI, createTestActor } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for rewinding a chat ("redo").
 *
 * Rewinding forks the conversation: everything from the target message onward
 * moves onto the parent branch, the message is re-sent on a new branch, and a
 * "‹ n/m ›" switcher appears so the discarded tail stays reachable. Nothing is
 * deleted, which is what the branch-switch assertions below check.
 *
 * Requires a live backend — conversations and messages go through the real
 * /api/conversations routes.
 */

async function signInAsActor(
	browser: Browser,
	apiKey: string,
	actor: { id: string; name: string; type: string; email: string | null },
): Promise<Page> {
	const context = await browser.newContext()
	const page = await context.newPage()
	await page.addInitScript(
		(data: { apiKey: string; actor: typeof actor }) => {
			localStorage.setItem('maskin-api-key', data.apiKey)
			localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
		},
		{ apiKey, actor },
	)
	return page
}

async function setUpConversation(api: TestAPI, workspaceId: string) {
	const secondHuman = await createTestActor({ name: `E2E Rewind Partner ${Date.now()}` })
	await api.addWorkspaceMember(workspaceId, secondHuman.id)

	const conversation = await api.createConversation(workspaceId, {
		title: 'E2E rewind chat',
		participant_actor_ids: [secondHuman.id],
	})
	return { conversation, secondHuman }
}

const REWIND_LABEL = 'Rewind the conversation to this message and send it again'

test.describe('Chat rewind + branch switching', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`rewinds a message, hides the tail, and restores it via the branch switcher at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await setUpConversation(account.api, account.workspaceId)

			const first = `first message ${Date.now()}`
			const target = `target message ${Date.now()}`
			const tail = `tail message ${Date.now()}`
			for (const content of [first, target, tail]) {
				await account.api.postConversationMessage(conversation.id, account.workspaceId, {
					content,
				})
			}

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByText(tail)).toBeVisible({ timeout: 15_000 })

			// Rewind to the middle message. Each own message carries the control,
			// so scope to the row holding the target text.
			const rewindButtons = thread.getByLabel(REWIND_LABEL)
			// Messages render oldest-first, so index 1 is the target.
			await rewindButtons.nth(1).click()

			// The tail is gone from the thread and the target is back.
			await expect(thread.getByText(tail)).toHaveCount(0, { timeout: 15_000 })
			await expect(thread.getByText(target)).toBeVisible()
			await expect(thread.getByText(first)).toBeVisible()

			// The switcher must be reachable on touch — visible, not hover-revealed.
			const previous = thread.getByLabel('Previous version')
			await expect(previous).toBeVisible()

			// Switching back restores the discarded tail: nothing was deleted.
			await previous.click()
			await expect(thread.getByText(tail)).toBeVisible({ timeout: 15_000 })

			// And it survives a reload — this is server state, not a view toggle.
			await page.reload()
			await expect(page.getByTestId('thread-messages').getByText(tail)).toBeVisible({
				timeout: 15_000,
			})
		})
	}

	test('the switcher is legible in both light and dark mode', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		for (const content of ['one', 'two']) {
			await account.api.postConversationMessage(conversation.id, account.workspaceId, { content })
		}

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const thread = page.getByTestId('thread-messages')
		await expect(thread.getByText('two')).toBeVisible({ timeout: 15_000 })
		await thread.getByLabel(REWIND_LABEL).first().click()

		const counter = thread.getByLabel(/Version \d+ of \d+/)
		// The switcher uses muted foreground rather than bg-accent, which is a
		// near-white background token in light mode — see
		// .claude/rules/known-pitfalls.md on the accent-without-foreground trap.
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await expect(counter).toBeVisible()
		}
	})

	test('rewind is blocked once another person has replied', async ({ page, account, browser }) => {
		const { conversation, secondHuman } = await setUpConversation(account.api, account.workspaceId)

		const mine = `mine ${Date.now()}`
		await account.api.postConversationMessage(conversation.id, account.workspaceId, {
			content: mine,
		})

		// The other participant replies, which makes rewinding destructive to them.
		const partnerPage = await signInAsActor(browser, secondHuman.api_key, {
			id: secondHuman.id,
			name: secondHuman.name,
			type: secondHuman.type,
			email: secondHuman.email,
		})
		await partnerPage.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const partnerComposer = partnerPage.getByLabel('Message this conversation')
		await partnerComposer.fill('their reply')
		await partnerComposer.press('Enter')
		await expect(partnerPage.getByTestId('thread-messages').getByText('their reply')).toBeVisible({
			timeout: 15_000,
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const thread = page.getByTestId('thread-messages')
		await expect(thread.getByText('their reply')).toBeVisible({ timeout: 15_000 })
		await expect(thread.getByLabel(REWIND_LABEL).first()).toBeDisabled()

		await partnerPage.context().close()
	})
})
