import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type TestAPI, createTestActor } from '../helpers/api.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
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

async function setUpConversation(api: TestAPI, workspaceId: string, apiKey: string) {
	// A trial workspace allows a single human seat — this spec needs two.
	await grantPlanHeadroom(apiKey, workspaceId)
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
				account.apiKey,
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
		const { conversation, secondHuman } = await setUpConversation(
			account.api,
			account.workspaceId,
			account.apiKey,
		)

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
		const { conversation } = await setUpConversation(
			account.api,
			account.workspaceId,
			account.apiKey,
		)

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
		const { conversation, secondHuman } = await setUpConversation(
			account.api,
			account.workspaceId,
			account.apiKey,
		)
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

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`edits an own message inline and shows the (edited) marker at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await setUpConversation(
				account.api,
				account.workspaceId,
				account.apiKey,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const composer = page.getByLabel('Message this conversation')
			await composer.fill('Original wording with a typo')
			await composer.press('Enter')

			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByText('Original wording with a typo')).toBeVisible({
				timeout: 10_000,
			})

			// The action renders only once the optimistic bubble reconciles with
			// the persisted row (a real message id) — and must be reachable
			// without hover, so plain toBeVisible is the touch-viewport check.
			const editButton = page.getByRole('button', { name: 'Edit message' })
			await expect(editButton).toBeVisible({ timeout: 10_000 })
			await editButton.click()

			// After entering edit mode the icon button unmounts, so the label
			// uniquely addresses the inline textarea.
			const editor = page.getByLabel('Edit message')
			await expect(editor).toHaveValue('Original wording with a typo')
			await editor.fill('Corrected wording, no typo')
			await page.getByRole('button', { name: 'Save' }).click()

			await expect(thread.getByText('Corrected wording, no typo')).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByText('(edited)')).toBeVisible({ timeout: 10_000 })

			// The edit survives a reload — it was persisted, not just optimistic.
			await page.reload()
			await expect(thread.getByText('Corrected wording, no typo')).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByText('(edited)')).toBeVisible({ timeout: 10_000 })
		})

		test(`retries an agent response from an own message at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await setUpConversation(
				account.api,
				account.workspaceId,
				account.apiKey,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const composer = page.getByLabel('Message this conversation')
			await composer.fill('Anyone there? Please respond')
			await composer.press('Enter')

			const retryButton = page.getByRole('button', { name: 'Ask agents to respond again' })
			await expect(retryButton).toBeVisible({ timeout: 10_000 })
			await retryButton.click()

			// The backend accepts the retry (202) and the UI confirms via toast.
			await expect(page.getByText('Asked the agents to respond')).toBeVisible({
				timeout: 10_000,
			})
		})
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a chat started from the UI gets a placeholder title, not the agent's name, at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agentName = `E2E Titler Agent ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(
				`/${account.workspaceId}/chats/new?agentId=${agent.id}&agentName=${encodeURIComponent(agentName)}`,
			)
			const composer = page.getByLabel('Message this conversation')
			await composer.fill('The deploy pipeline keeps failing on the migrate step')
			await composer.press('Enter')

			await page.waitForURL(/\/chats\/[0-9a-f-]{36}/, { timeout: 15_000 })
			const heading = page.getByRole('heading').first()
			await expect(heading).toBeVisible({ timeout: 10_000 })

			// The title is either still the placeholder or already replaced by the
			// backend auto-titler (conversation-titler.ts) — both are correct, and
			// which one you get depends on whether the environment has an LLM
			// credential. What must never come back is the old behaviour of naming
			// the conversation after its participants. The generated text itself
			// isn't asserted: that would need a live model.
			await expect(heading).not.toHaveText(agentName)
		})
	}
})
