import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The group-chat composer cue: the box under the message names who will answer, or says that
 * nobody will. The composer is never disabled while anything loads.
 */

const NEUTRAL = 'Message this conversation'
const NEUTRAL_PLACEHOLDER = 'Message · @ to mention'
const HINT_NOBODY = 'No agent will reply. Tag one with @.'

/** The tag input draws its placeholder as a span beside the box, only while the box is empty. */
const placeholderOf = (box: Locator) => box.locator('xpath=../span[@aria-hidden="true"]')

/** Holds the requests the cue depends on for `ms`, so loading states can be observed. */
async function throttleCueRequests(page: Page, ms: number) {
	await page.route(/\/api\/(conversations\/[^/?]+(\/messages)?)(\?|$)/, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, ms))
		await route.continue()
	})
}

async function agentsInChat(
	account: { api: import('../helpers/api.helper').TestAPI; workspaceId: string },
	count: number,
) {
	const stamp = Date.now()
	const agents = []
	for (let i = 0; i < count; i++) {
		const agent = await account.api.createAgentActor(`Cue Agent ${i} ${stamp}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		agents.push(agent)
	}
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Cue chat ${stamp}`,
		participant_actor_ids: agents.map((a) => a.id),
	})
	return { agents, conversation }
}

test.describe('Group chat composer cue', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a fresh chat with two agents says nobody will answer, once the box is used @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await agentsInChat(account, 3)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByRole('textbox', { name: NEUTRAL })
			await expect(box).toBeVisible({ timeout: 15_000 })

			// Nobody would answer, but nothing is said on arrival: the box is not focused.
			await expect(placeholderOf(box)).toHaveText(NEUTRAL_PLACEHOLDER)
			await expect(page.getByText(HINT_NOBODY)).toHaveCount(0)

			await box.click()
			const hint = page.getByText(HINT_NOBODY)
			await expect(hint).toBeVisible()
			// Polite live region, linked to the box, and the box keeps its name.
			await expect(hint).toHaveAttribute('aria-live', 'polite')
			const hintId = await hint.getAttribute('id')
			await expect(box).toHaveAttribute('aria-describedby', hintId ?? '')
			// At most two lines of text-xs (16px line height).
			const hintBox = await hint.boundingBox()
			expect(hintBox?.height ?? 0).toBeLessThanOrEqual(34)

			// A decorative info glyph leads the text, and 8 px separate it from the bar above it.
			await expect(hint.locator('svg')).toHaveAttribute('aria-hidden', 'true')
			const barBox = await box
				.locator("xpath=ancestor::div[contains(@class,'rounded-3xl')][1]")
				.boundingBox()
			const barBottom = (barBox?.y ?? 0) + (barBox?.height ?? 0)
			expect(Math.round((hintBox?.y ?? 0) - barBottom)).toBe(8)

			// Picking a tag leaves the chip in the box, so the placeholder gives way to it.
			await box.press('@')
			await page.getByRole('option', { name: /Cue Agent 0/ }).click()
			await expect(box.locator('[data-tag-id]')).toHaveText(/Cue Agent 0/)
			await expect(placeholderOf(box)).toHaveCount(0)
		})
	}

	test('never disables the box while participants and messages load, in a 1-1 and a group chat', async ({
		page,
		account,
	}) => {
		const oneToOne = await agentsInChat(account, 1)
		const group = await agentsInChat(account, 3)
		await throttleCueRequests(page, 2_500)

		for (const { conversation } of [oneToOne, group]) {
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByRole('textbox', { name: NEUTRAL })
			await expect(box).toBeVisible({ timeout: 15_000 })

			// While the requests are held: neutral text, no hint, and typing works.
			await expect(box).toBeEnabled()
			await expect(placeholderOf(box)).toHaveText(NEUTRAL_PLACEHOLDER)
			await box.fill('typed while loading')
			await expect(box).toHaveText('typed while loading')
			await expect(page.getByText(HINT_NOBODY)).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()

			// Once the data lands the text is still there and the box is still enabled.
			await expect(box).toBeEnabled()
			await expect(box).toHaveText('typed while loading')
		}
	})
})
