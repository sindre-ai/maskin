import { expect, test } from '../fixtures/auth.fixture'
import { grantPlanHeadroom } from '../helpers/plan.helper'

/**
 * Regression coverage for the [Bug][backfill] "Older messages can't be loaded
 * in chat" report. The thread route pages messages backwards via
 * `useConversationMessages`, but before this fix the "Load older messages"
 * button lived at the top of a scroller auto-pinned to the bottom, so a
 * reader on a thread of >MESSAGES_PAGE_SIZE (50) messages had no way to
 * discover it and reported the feature as broken.
 *
 * The fix adds a top sentinel + IntersectionObserver: scrolling to the top
 * fires `fetchNextPage` automatically, and the reader's visual position is
 * preserved as older messages get prepended.
 *
 * Requires a live backend — messages are inserted via TestAPI and the thread
 * is loaded through the real `/api/conversations/:id/messages` pagination.
 */
test.describe('Chats — backward pagination for older messages', () => {
	test('scrolling to the top loads older messages and preserves the reader position', async ({
		page,
		account,
	}) => {
		await grantPlanHeadroom(account.apiKey, account.workspaceId)
		const partner = await account.api.createAgentActor(`Backfill Partner ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, partner.id)

		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Backfill regression thread',
			participant_actor_ids: [partner.id],
		})

		// Seed 60 messages (one page is 50). Older messages are the low ids;
		// the newest 50 land in the first page and the remaining 10 are what
		// backward pagination has to reach.
		const total = 60
		for (let i = 1; i <= total; i++) {
			await account.api.postConversationMessage(conversation.id, account.workspaceId, {
				content: `seeded message ${i}`,
			})
		}

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const thread = page.getByTestId('thread-messages')
		await expect(thread).toBeVisible({ timeout: 15_000 })

		// The newest message is on-screen by default (auto-scroll pins to
		// bottom); the oldest one is behind an older-page fetch that hasn't
		// happened yet.
		await expect(thread.getByText(`seeded message ${total}`)).toBeVisible({ timeout: 10_000 })
		await expect(thread.getByText('seeded message 1')).toHaveCount(0)

		// Scrolling to the top must trigger the older-page load — this is what
		// the reporter said was broken. The IntersectionObserver has a 200px
		// rootMargin so we don't have to hit scrollTop === 0 exactly.
		await thread.evaluate((el) => {
			el.scrollTop = 0
		})
		await expect(thread.getByText('seeded message 1')).toBeVisible({ timeout: 15_000 })

		// The button remains as an accessible fallback but should not be the
		// only path — the reader never had to click it.
		await expect(page.getByRole('button', { name: /Load older messages/ })).toHaveCount(0, {
			timeout: 5_000,
		})
	})
})
