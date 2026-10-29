import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * Linked-object cards and chip previews in the reply thread sidebar (the right rail, 400px at 1024
 * and 440px at 1280 and up). The rail is narrower than the 380px hover preview plus the gutter, so
 * the preview and the cards must fit the pane: no sideways scroll, nothing cut off.
 */

const WIDTHS = [VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]

test.describe('Chat — cards and chip previews fit the reply thread sidebar', () => {
	for (const vp of WIDTHS) {
		test(`${vp.width} wide: no sideways scroll, cards inside the pane, preview pinned inside it`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Sidebar Fit Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const bet = await account.api.createObject(ws, {
				type: 'bet',
				title: 'If events carry the change, tabs stop refetching the whole workspace on focus',
				status: 'opportunity',
				content: 'Tabs refetch on every focus today. Events can carry the change instead.',
				driver: agent.id,
			})
			const task = await account.api.createObject(ws, {
				type: 'task',
				title: 'Draw the preview inside the sidebar',
				status: 'todo',
				content: 'The preview is the same card, opened under the chip.',
				driver: agent.id,
			})
			const insight = await account.api.createObject(ws, {
				type: 'insight',
				title: 'Edge chip',
				status: 'new',
				content: 'A chip in the sidebar.',
			})
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E sidebar fit',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			const root = await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: [
					'Two things for you.',
					`[${bet.title}](/${ws}/objects/${bet.id})`,
					`[${task.title}](/${ws}/objects/${task.id})`,
					`And a sentence that ends on a chip for [${insight.title}](/${ws}/objects/${insight.id})`,
				].join('\n\n'),
			})

			await page.goto(`/${ws}/chats/${conversation.id}?thread=${root.id}`)
			const rail = page.getByRole('complementary', { name: 'Thread pane' })
			const pane = rail.locator('[aria-label="Thread"]')
			const scroller = pane.locator('.overflow-y-auto').first()
			await expect(pane.locator('[data-linked-card]')).toHaveCount(2, { timeout: 10_000 })
			const chip = pane.getByRole('link', { name: /^Insight, New: / })
			await expect(chip).toBeVisible()

			const sideways = () =>
				scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
			const paneBox = (await scroller.boundingBox()) ?? { x: 0, width: 0 }

			// The status pill and the open arrow are inside the pane, not cut off at its edge.
			for (const card of await pane.locator('[data-linked-card]').all()) {
				const box = await card.boundingBox()
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(paneBox.x + paneBox.width)
			}
			expect((await sideways()).scroll).toBeLessThanOrEqual((await sideways()).client)

			// The chip sits where the sentence puts it; the preview is wider than the room beside it.
			await chip.hover()
			const preview = page.locator('[data-linked-preview]')
			await expect(preview).toBeVisible()
			const previewBox = await preview.boundingBox()
			const left = previewBox?.x ?? 0
			const right = left + (previewBox?.width ?? 0)
			expect(left).toBeGreaterThanOrEqual(paneBox.x)
			expect(right).toBeLessThanOrEqual(paneBox.x + paneBox.width)
			expect((await sideways()).scroll).toBeLessThanOrEqual((await sideways()).client)
			await page.screenshot({ path: `test-results/thread-sidebar-fit-${vp.width}.png` })
		})
	}
})
