import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Regression pin for the iOS composer-text-loss bug.
 *
 * Repro (Sebk, #maskin-app): on iOS, navigate away from the browser to another
 * app and back — the text typed in the chat composer is gone. The mechanism is
 * that Safari discards and *reloads* the tab under memory pressure, so the
 * React tree is rebuilt from empty state and the textarea loses its uncontrolled
 * value.
 *
 * The fix mirrors an opt-in draft into `sessionStorage` under
 * `composer-draft:<conversationId>` and restores it on mount. This spec drives
 * the same reload path (a reload is exactly what the app switch produces) and
 * asserts the typed text comes back — plus that a draft does not leak into a
 * different conversation, which is the boundary the storage key exists for.
 *
 * The reload leg is the load-bearing one: a visibility hidden→visible toggle
 * with the page still in memory would pass even without the fix, since the
 * useState value survives. Only a reload proves the draft outlived the tree.
 */

async function setUpConversation(api: TestAPI, workspaceId: string) {
	const agent = await api.createAgentActor(`E2E Draft Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)

	const conversation = await api.createConversation(workspaceId, {
		title: 'E2E composer draft',
		participant_actor_ids: [agent.id],
	})
	const other = await api.createConversation(workspaceId, {
		title: 'E2E composer draft (other)',
		participant_actor_ids: [agent.id],
	})

	return { conversation, other }
}

const DRAFT = 'half-written prompt that must survive an app switch'

test.describe('Composer draft survives an iOS app switch (tab reload)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`restores an unsent draft after reload and keeps it out of other conversations at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation, other } = await setUpConversation(account.api, account.workspaceId)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByRole('heading', { name: 'E2E composer draft' })).toBeVisible({
				timeout: 10_000,
			})

			const composer = page.getByLabel('Message this conversation')
			await expect(composer).toBeVisible()
			await composer.fill(DRAFT)
			await expect(composer).toHaveValue(DRAFT)

			// The draft must be persisted before "leaving the app", not only in
			// React state — this is what the reload below depends on.
			const stored = await page.evaluate(
				(key: string) => sessionStorage.getItem(`composer-draft:${key}`),
				conversation.id,
			)
			expect(stored).toBe(DRAFT)

			// Simulates iOS discarding and reloading the tab on app switch.
			await page.reload()
			await expect(page.getByRole('heading', { name: 'E2E composer draft' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByLabel('Message this conversation')).toHaveValue(DRAFT)

			// The draft is keyed per conversation — opening another thread must
			// show an empty composer, not the previous thread's text.
			await page.goto(`/${account.workspaceId}/chats/${other.id}`)
			await expect(page.getByRole('heading', { name: 'E2E composer draft (other)' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByLabel('Message this conversation')).toHaveValue('')

			// Returning to the original thread still restores its own draft.
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByRole('heading', { name: 'E2E composer draft' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByLabel('Message this conversation')).toHaveValue(DRAFT)
		})
	}
})
