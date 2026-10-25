import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Reply threads in the web chat: the Reply action on a message, the "N replies" pill, the
 * thread pane (right rail at 1024px, bottom sheet below) and read state.
 *
 * The server returns replies mixed into the newest-first message pages, so the claim that a
 * reply stays out of the main timeline is only proven by reloading the page and reading the
 * timeline again: nothing optimistic is left to hide it.
 *
 * Requires a live backend. Every conversation, message and second person is created through
 * the real routes via TestAPI.
 */

const isDesktop = (width: number) => width >= 1024

async function seedChat(
	account: { api: TestAPI; workspaceId: string },
	participantActorIds: string[] = [],
	poster: TestAPI = account.api,
): Promise<{ conversationId: string; rootId: number; rootText: string }> {
	const stamp = Date.now()
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `E2E threads ${stamp}`,
		participant_actor_ids: participantActorIds,
	})
	const rootText = `Root message ${stamp}`
	const root = await poster.postConversationMessage(conversation.id, account.workspaceId, {
		content: rootText,
	})
	return { conversationId: conversation.id, rootId: root.id, rootText }
}

/** A second person in the workspace, posting through their own key. */
async function createSecondPerson(account: { api: TestAPI; workspaceId: string; apiKey: string }) {
	// A trial workspace allows a single human seat; this needs two.
	await grantPlanHeadroom(account.apiKey, account.workspaceId)
	const actor = await createTestActor({ name: `E2E Replier ${Date.now()}` })
	await account.api.addWorkspaceMember(account.workspaceId, actor.id)
	return { id: actor.id, api: new TestAPI(actor.api_key) }
}

function timeline(page: Page) {
	return page.getByTestId('thread-messages')
}

function pane(page: Page) {
	return page.locator('[aria-label="Thread"]')
}

/** A reply row in the pane (not the composer, which can still hold draft text). */
function paneReply(page: Page, text: string) {
	return pane(page).locator('[data-message-id]').filter({ hasText: text })
}

async function openChat(page: Page, workspaceId: string, conversationId: string, thread?: number) {
	const query = thread ? `?thread=${thread}` : ''
	await page.goto(`/${workspaceId}/chats/${conversationId}${query}`)
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	// Someone else's message keeps its actions in the hover-gated row. Under a touch context
	// (pointer: coarse) that row must be fully opaque with no hover, and Reply a 32px target.
	// toBeVisible() ignores opacity, so the opacity is asserted as computed CSS.
	test.describe(`Reply reachability by touch at ${vp.label}`, () => {
		test.use({ hasTouch: true, isMobile: true })

		test("Reply on another person's message is opaque and at least 32x32 without hover", async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const other = await createSecondPerson(account)
			const { conversationId, rootText } = await seedChat(account, [other.id], other.api)

			await openChat(page, account.workspaceId, conversationId)
			await expect(timeline(page).getByText(rootText)).toBeVisible({ timeout: 10_000 })

			const actions = timeline(page).getByLabel('Message actions')
			await expect(actions).toHaveCSS('opacity', '1')
			const replyButton = actions.getByRole('button', { name: 'Reply in thread' })
			await expect(replyButton).toBeVisible()
			const box = await replyButton.boundingBox()
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(32)
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(32)

			await replyButton.tap()
			await expect(pane(page)).toBeVisible()
		})
	})

	test.describe(`Reply threads at ${vp.label}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
		})

		test('a reply shows in the thread, never in the main timeline, and survives a reload', async ({
			page,
			account,
		}) => {
			const { conversationId, rootText } = await seedChat(account)
			await openChat(page, account.workspaceId, conversationId)
			await expect(timeline(page).getByText(rootText)).toBeVisible({ timeout: 10_000 })

			const replyButton = page.getByRole('button', { name: 'Reply in thread' })
			await expect(replyButton).toBeVisible()
			if (vp.width <= 375) {
				const box = await replyButton.boundingBox()
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(32)
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(32)
			}
			await replyButton.click()

			await expect(pane(page)).toBeVisible()
			if (isDesktop(vp.width)) {
				await expect(page.getByRole('complementary', { name: 'Thread pane' })).toBeVisible()
			} else {
				await expect(page.getByRole('dialog', { name: 'Thread' })).toBeVisible()
			}

			const replyText = `Quiet reply ${Date.now()}`
			await pane(page).getByLabel('Reply in thread').fill(replyText)
			await pane(page).getByRole('button', { name: 'Send message' }).click()
			await expect(paneReply(page, replyText)).toBeVisible()
			await expect(timeline(page).getByText(replyText)).toHaveCount(0)

			// Reload: the thread reopens from the URL and the reply is still there.
			await page.reload()
			await expect(paneReply(page, replyText)).toBeVisible({ timeout: 10_000 })

			// Close the pane: the main timeline holds the root and its pill, not the reply.
			await pane(page).getByRole('button', { name: 'Close thread' }).click()
			await expect(pane(page)).toHaveCount(0)
			await expect(timeline(page).getByText(rootText)).toBeVisible()
			await expect(timeline(page).getByText(replyText)).toHaveCount(0)
			await expect(page.getByRole('button', { name: '1 reply. Open thread' })).toBeVisible()
			expect(page.url()).not.toContain('thread=')
		})

		test('a reply sent only to the thread never appears in main, one sent to the chat does', async ({
			page,
			account,
		}) => {
			const other = await createSecondPerson(account)
			const { conversationId, rootId, rootText } = await seedChat(account, [other.id])
			const quiet = `Thread only ${Date.now()}`
			const loud = `Also in chat ${Date.now()}`
			await other.api.postConversationMessage(conversationId, account.workspaceId, {
				content: quiet,
				thread_root_id: rootId,
				also_in_channel: false,
			})
			await other.api.postConversationMessage(conversationId, account.workspaceId, {
				content: loud,
				thread_root_id: rootId,
				also_in_channel: true,
			})

			await openChat(page, account.workspaceId, conversationId)
			await expect(timeline(page).getByText(rootText)).toBeVisible({ timeout: 10_000 })
			await expect(timeline(page).getByText(loud)).toBeVisible()
			await expect(timeline(page).getByText(quiet)).toHaveCount(0)

			await openChat(page, account.workspaceId, conversationId, rootId)
			await expect(paneReply(page, quiet)).toBeVisible({ timeout: 10_000 })
			await expect(paneReply(page, loud)).toBeVisible()
		})

		test('opening a thread clears its unread pill, confirmed against the API', async ({
			page,
			account,
		}) => {
			const other = await createSecondPerson(account)
			const { conversationId, rootId, rootText } = await seedChat(account, [other.id])
			await other.api.postConversationMessage(conversationId, account.workspaceId, {
				content: 'Something new for you',
				thread_root_id: rootId,
			})

			await openChat(page, account.workspaceId, conversationId)
			await expect(timeline(page).getByText(rootText)).toBeVisible({ timeout: 10_000 })
			const pill = page.getByRole('button', { name: '1 new reply. Open thread' })
			await expect(pill).toBeVisible()
			await pill.click()
			await expect(paneReply(page, 'Something new for you')).toBeVisible()

			await expect
				.poll(
					async () => {
						const page1 = await account.api.listConversationMessages(
							conversationId,
							account.workspaceId,
						)
						return page1.messages.find((m) => m.id === rootId)?.thread?.unreadCount
					},
					{ timeout: 10_000 },
				)
				.toBe(0)

			await pane(page).getByRole('button', { name: 'Close thread' }).click()
			await expect(page.getByRole('button', { name: '1 reply. Open thread' })).toBeVisible()
		})

		test('?thread= opens the pane on load, and Escape closes it on desktop', async ({
			page,
			account,
		}) => {
			const { conversationId, rootId, rootText } = await seedChat(account)
			await openChat(page, account.workspaceId, conversationId, rootId)

			await expect(pane(page)).toBeVisible({ timeout: 10_000 })
			await expect(pane(page).getByText(rootText)).toBeVisible()
			await expect(pane(page).getByText('No replies yet')).toBeVisible()
			if (isDesktop(vp.width)) {
				await expect(page.getByRole('complementary', { name: 'Thread pane' })).toBeVisible()
				await pane(page).getByLabel('Reply in thread').click()
				await page.keyboard.press('Escape')
				await expect(pane(page)).toHaveCount(0)
				expect(page.url()).not.toContain('thread=')
			} else {
				await expect(page.getByRole('dialog', { name: 'Thread' })).toBeVisible()
			}
		})

		test('the Threads filter lists a thread with unread replies and opens it', async ({
			page,
			account,
		}) => {
			const other = await createSecondPerson(account)
			const { conversationId, rootId } = await seedChat(account, [other.id])
			const replyText = `Unread reply ${Date.now()}`
			await other.api.postConversationMessage(conversationId, account.workspaceId, {
				content: replyText,
				thread_root_id: rootId,
			})

			await page.goto(`/${account.workspaceId}/chats?filter=threads`)
			const row = page.getByTestId('reply-thread-list').getByRole('link', { name: /E2E threads/ })
			await expect(row).toBeVisible({ timeout: 10_000 })
			await expect(row.getByLabel('1 unread')).toBeVisible()
			await expect(row).toContainText('1 reply')

			await row.click()
			await expect(paneReply(page, replyText)).toBeVisible({ timeout: 10_000 })
			expect(page.url()).toContain(`thread=${rootId}`)
		})

		test('the pill and the pane render in light and dark', async ({ page, account }) => {
			const other = await createSecondPerson(account)
			const { conversationId, rootId } = await seedChat(account, [other.id])
			await other.api.postConversationMessage(conversationId, account.workspaceId, {
				content: 'Colour check',
				thread_root_id: rootId,
			})

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await openChat(page, account.workspaceId, conversationId)
				const pill = page.getByRole('button', { name: /Open thread/ })
				await expect(pill).toBeVisible({ timeout: 10_000 })
				await pill.click()
				await expect(paneReply(page, 'Colour check')).toBeVisible()
			}
		})
	})
}
