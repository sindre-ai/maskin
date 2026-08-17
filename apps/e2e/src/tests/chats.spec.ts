import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type TestAPI, createTestActor } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for the full-screen multi-human/multi-agent chat surface
 * (`/$workspaceId/chats`), replacing the old single-agent sidebar sheet.
 *
 * Requires a live backend — conversations are created and messages posted
 * via the real `/api/conversations` routes (TestAPI), not mocked.
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
	const secondHuman = await createTestActor({ name: `E2E Chat Partner ${Date.now()}` })
	await api.addWorkspaceMember(workspaceId, secondHuman.id)
	const agent = await api.createAgentActor(`E2E Chat Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)

	const conversation = await api.createConversation(workspaceId, {
		title: 'E2E multi-party chat',
		participant_actor_ids: [secondHuman.id, agent.id],
	})

	return { conversation, secondHuman, agent }
}

test.describe('Chats — full-screen multi-party chat', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`creates a conversation, sends a message, and the other participant sees it via SSE at ${vp.label}`, async ({
			page,
			account,
			browser,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation, secondHuman } = await setUpConversation(
				account.api,
				account.workspaceId,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByRole('heading', { name: 'E2E multi-party chat' })).toBeVisible({
				timeout: 10_000,
			})

			const partnerPage = await signInAsActor(browser, secondHuman.api_key, {
				id: secondHuman.id,
				name: secondHuman.name,
				type: secondHuman.type,
				email: secondHuman.email,
			})
			await partnerPage.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(partnerPage.getByRole('heading', { name: 'E2E multi-party chat' })).toBeVisible({
				timeout: 10_000,
			})

			const messageText = `Hello from the primary actor ${Date.now()}`
			const composer = page.getByLabel('Message this conversation')
			await composer.fill(messageText)
			await composer.press('Enter')

			// Sender sees its own optimistic send immediately. Scoped to the
			// thread's message list (not a bare page-wide text search) — the
			// composer's own textarea still holds the same text until the send
			// resolves and clears it, and would otherwise collide as a second
			// match under Playwright's strict mode.
			await expect(page.getByTestId('thread-messages').getByText(messageText)).toBeVisible({
				timeout: 10_000,
			})

			// The other participant receives it in real time via the SSE ->
			// invalidateFromSSE('conversation') -> messages refetch path, no
			// manual reload.
			await expect(partnerPage.getByTestId('thread-messages').getByText(messageText)).toBeVisible({
				timeout: 15_000,
			})

			await partnerPage.context().close()
		})
	}

	test('pin, archive, and unread state persist across reload', async ({
		page,
		account,
		browser,
	}) => {
		const { conversation, secondHuman } = await setUpConversation(account.api, account.workspaceId)

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByRole('heading', { name: 'E2E multi-party chat' })).toBeVisible({
			timeout: 10_000,
		})

		await page.getByRole('button', { name: 'Pin conversation' }).click()
		await expect(page.getByRole('button', { name: 'Unpin conversation' })).toBeVisible()

		await page.reload()
		await expect(page.getByRole('button', { name: 'Unpin conversation' })).toBeVisible({
			timeout: 10_000,
		})

		await page.getByRole('button', { name: 'Archive conversation' }).click()
		await expect(page.getByRole('button', { name: 'Unarchive conversation' })).toBeVisible()

		// A second participant posts a message while the primary actor isn't
		// looking — it should surface as unread in the conversation list.
		await account.api.postConversationMessage(conversation.id, account.workspaceId, {
			content: 'Are you still there?',
		})

		const partnerPage = await signInAsActor(browser, secondHuman.api_key, {
			id: secondHuman.id,
			name: secondHuman.name,
			type: secondHuman.type,
			email: secondHuman.email,
		})
		await partnerPage.goto(`/${account.workspaceId}/chats`)
		const row = partnerPage.getByRole('link', { name: /E2E multi-party chat/ })
		await expect(row.getByLabel(/unread/)).toBeVisible({ timeout: 10_000 })

		await partnerPage.context().close()
	})

	test('mobile back button returns to the conversation list', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { conversation } = await setUpConversation(account.api, account.workspaceId)

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByRole('heading', { name: 'E2E multi-party chat' })).toBeVisible({
			timeout: 10_000,
		})

		await page.getByRole('button', { name: 'Back to conversations' }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/?$`))
		await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 10_000 })
	})

	test('message bubbles and the unread badge stay visible in light and dark mode', async ({
		page,
		account,
		browser,
	}) => {
		const { conversation, secondHuman } = await setUpConversation(account.api, account.workspaceId)
		await account.api.postConversationMessage(conversation.id, account.workspaceId, {
			content: 'Visible in both themes',
		})

		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			// Scoped to the message list — the conversation-list-row snippet in
			// the left pane shows the same text and would otherwise collide.
			const bubble = page.getByTestId('thread-messages').getByText('Visible in both themes')
			await expect(bubble).toBeVisible({ timeout: 10_000 })
		}

		// Unread dot on the conversation list row — verified from the partner's
		// perspective (the sender never has an unread count on their own send).
		const partnerPage = await signInAsActor(browser, secondHuman.api_key, {
			id: secondHuman.id,
			name: secondHuman.name,
			type: secondHuman.type,
			email: secondHuman.email,
		})
		for (const scheme of ['light', 'dark'] as const) {
			await partnerPage.emulateMedia({ colorScheme: scheme })
			await partnerPage.goto(`/${account.workspaceId}/chats`)
			// Scoped to the conversation row — a bare page-wide `getByLabel(/unread/)`
			// can collide with the sidebar's "Switch workspace" button, whose
			// aria-label embeds the actor's auto-generated test name (which itself
			// contains this test's title, including the word "unread").
			const row = partnerPage.getByRole('link', { name: /E2E multi-party chat/ })
			const badge = row.getByLabel(/unread/)
			await expect(badge).toBeVisible({ timeout: 10_000 })
		}
		await partnerPage.context().close()
	})
})
