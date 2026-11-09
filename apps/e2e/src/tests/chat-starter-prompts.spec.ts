import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// An agent's own one-tap openers (actors.metadata.starter_prompts) show as chips above the
// message box in a new chat with it, and in an empty thread with it. A tap fills the box and
// focuses it; nothing is sent until the person sends. An agent with none shows no chips.

const FIRST = 'What needs me today?'
const SECOND = 'Summarise the open decisions'

test.describe('Chat — agent starter prompts', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`new chat: chips fill the message box and focus it, nothing is sent, at ${vp.width}px in ${scheme}`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.addInitScript((mode) => localStorage.setItem('maskin-theme', mode), scheme)
				const ws = account.workspaceId
				const stamp = Date.now()
				const opener = await account.api.createAgentActor(`Opener ${stamp}`)
				await account.api.updateActor(opener.id, { starter_prompts: [FIRST, SECOND] }, ws)
				const silent = await account.api.createAgentActor(`Silent ${stamp}`)

				await page.goto(`/${ws}/chats/new?agentId=${opener.id}`)
				const first = page.getByRole('button', { name: FIRST })
				const second = page.getByRole('button', { name: SECOND })
				await expect(first).toBeVisible({ timeout: 10_000 })
				await expect(second).toBeVisible()
				// A touch target, not a hairline: at least 44px tall.
				const box = await first.boundingBox()
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
				// No sideways scroll from the chips at any width.
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				)
				expect(overflow).toBeLessThanOrEqual(0)

				const input = page.getByLabel('First message')
				await first.click()
				await expect(input).toHaveValue(FIRST)
				await expect(input).toBeFocused()
				await expect(page).toHaveURL(/\/chats\/new/)
				// Picking another replaces the text, it does not append.
				await second.click()
				await expect(input).toHaveValue(SECOND)

				// The person sends it, and it arrives as written.
				await page.getByRole('button', { name: 'Start chat' }).click()
				await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/, { timeout: 15_000 })
				await expect(page.getByText(SECOND).first()).toBeVisible({ timeout: 15_000 })

				// An agent with no starters shows none, and no stand-in list.
				await page.goto(`/${ws}/chats/new?agentId=${silent.id}`)
				await expect(page.getByLabel('First message')).toBeVisible({ timeout: 10_000 })
				await expect(page.getByTestId('starter-prompts')).toHaveCount(0)
			})

			test(`empty thread: chips fill the composer and nothing is sent, at ${vp.width}px in ${scheme}`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.addInitScript((mode) => localStorage.setItem('maskin-theme', mode), scheme)
				const ws = account.workspaceId
				const stamp = Date.now()
				const opener = await account.api.createAgentActor(`Threadopener ${stamp}`)
				await account.api.updateActor(opener.id, { starter_prompts: [FIRST] }, ws)
				const conv = await account.api.createConversation(ws, {
					title: `Starter thread ${stamp}`,
					participant_actor_ids: [opener.id],
				})

				await page.goto(`/${ws}/chats/${conv.id}`)
				await expect(page.getByText('No messages yet')).toBeVisible({ timeout: 10_000 })
				const chip = page.getByRole('button', { name: FIRST })
				await expect(chip).toBeVisible()
				await chip.click()
				await expect(page.getByRole('textbox').last()).toContainText(FIRST)
				// Still empty: a tap sent nothing.
				await expect(page.getByText('No messages yet')).toBeVisible()
			})
		}
	}
})
