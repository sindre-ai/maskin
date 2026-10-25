import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The group-chat composer cue: the box under the message names who will answer, or says that
 * nobody will. The composer is never disabled while anything loads.
 */

const NEUTRAL = 'Message this conversation'
const HINT_NOBODY = 'No agent will reply. Tag one with @.'

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
			await expect(box).toHaveAttribute('placeholder', NEUTRAL)
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

			// A decorative info glyph leads the text, and 8 px separate it from the control row.
			await expect(hint.locator('svg')).toHaveAttribute('aria-hidden', 'true')
			const sendBox = await page.getByRole('button', { name: 'Send message' }).boundingBox()
			const hintBottom = (hintBox?.y ?? 0) + (hintBox?.height ?? 0)
			expect(Math.round((sendBox?.y ?? 0) - hintBottom)).toBe(8)

			// Picking a tag leaves the box empty, so the cue placeholder shows behind the chip.
			await box.press('@')
			await page.getByRole('option', { name: /Cue Agent 0/ }).click()
			await expect(box).toHaveValue('')
			await expect(box).toHaveAttribute('placeholder', /^Reply to Cue Agent 0/)
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
			await expect(box).toHaveAttribute('placeholder', NEUTRAL)
			await box.fill('typed while loading')
			await expect(box).toHaveValue('typed while loading')
			await expect(page.getByText(HINT_NOBODY)).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()

			// Once the data lands the text is still there and the box is still enabled.
			await expect(box).toBeEnabled()
			await expect(box).toHaveValue('typed while loading')
		}
	})

	test('the new-chat screen says nobody will answer after picking two agents', async ({
		page,
		account,
	}) => {
		const stamp = Date.now()
		const first = await account.api.createAgentActor(`Cue Pick A ${stamp}`)
		const second = await account.api.createAgentActor(`Cue Pick B ${stamp}`)
		await account.api.addWorkspaceMember(account.workspaceId, first.id)
		await account.api.addWorkspaceMember(account.workspaceId, second.id)

		await page.goto(`/${account.workspaceId}/chats/new`)
		const to = page.getByLabel('Add recipients')
		await expect(to).toBeVisible({ timeout: 15_000 })
		for (const agent of [first, second]) {
			await to.fill(agent.name)
			await to.press('Enter')
			await expect(page.getByLabel(`Remove ${agent.name}`)).toBeVisible()
		}

		const box = page.getByRole('textbox', { name: NEUTRAL })
		await box.fill('hello both')
		await expect(box).toHaveAttribute('placeholder', NEUTRAL)
		await expect(page.getByText(HINT_NOBODY)).toBeVisible()
	})
})
