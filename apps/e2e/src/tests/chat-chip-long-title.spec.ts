import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const LONG_TITLE = 'Audit open bet PRs for work merged into a bet branch and never reported back'

test.describe('Chat — a chip title uses the whole text column', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`a long title is one line, cut only by the column, at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Chip QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const task = await account.api.createObject(ws, {
				type: 'task',
				title: LONG_TITLE,
				status: 'todo',
				driver: agent.id,
			})
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E chip long title',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: `Please look at [${LONG_TITLE}](/${ws}/objects/${task.id}) before Friday.`,
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const chip = page
				.getByTestId('thread-messages')
				.getByRole('link', { name: /^Task, To do: Audit open bet PRs/ })
			await expect(chip).toBeVisible({ timeout: 10_000 })
			const title = chip.locator('span.truncate')

			// One line, nothing sideways, and the chip stays inside the message's text column.
			const chipBox = await chip.boundingBox()
			const titleBox = await title.boundingBox()
			const column = await chip.evaluate((el) => {
				const text = el.closest('p')?.getBoundingClientRect()
				return { left: text?.left ?? 0, right: text?.right ?? 0 }
			})
			expect(titleBox?.height ?? 0).toBeLessThan(20)
			expect((chipBox?.x ?? 0) + (chipBox?.width ?? 0)).toBeLessThanOrEqual(column.right + 1)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			const cut = await title.evaluate((el) => el.scrollWidth > el.clientWidth)
			if (vp.width === VIEWPORTS.desktop.width) {
				// Room to spare: the whole title shows, well past the old 16rem (256px) cap.
				expect(cut).toBe(false)
				expect(titleBox?.width ?? 0).toBeGreaterThan(256)
			} else {
				// No room: the title is cut with an ellipsis and the chip fills the column.
				expect(cut).toBe(true)
				expect((chipBox?.x ?? 0) + (chipBox?.width ?? 0)).toBeGreaterThan(column.right - 24)
			}
			await page.screenshot({ path: `test-results/chip-long-title-${vp.width}.png` })
		})
	}
})
