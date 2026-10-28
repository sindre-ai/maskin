import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const INSTRUCTION = 'Sweep the inbox and write the digest'

test.describe('Chat — a linked loop and trigger draw like an object', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`one message mixes an object, a loop and a trigger as card, chip and preview at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Unfurl QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const task = await account.api.createObject(ws, {
				type: 'task',
				title: 'Write the weekly digest',
				status: 'todo',
				driver: agent.id,
			})
			const loop = await account.api.createObject(ws, {
				type: 'loop',
				title: 'Customer feedback',
				status: 'learning',
				content: 'Every customer who gives feedback hears back within 30 days',
			})
			const trigger = await account.api.createTrigger(ws, {
				name: 'Morning sweep',
				type: 'cron',
				action_prompt: INSTRUCTION,
				target_actor_id: agent.id,
				config: { expression: '0 9 * * 1-5' },
			})
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E linked loop and trigger',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: [
					`The task is [here](/${ws}/objects/${task.id}), the loop [runs it](/${ws}/loops/${loop.id}).`,
					`[the loop](/${ws}/loops/${loop.id})`,
					`[the trigger](/${ws}/triggers/${trigger.id})`,
				].join('\n\n'),
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			// The loop link alone on its line is a card with the loop's own name, not the link text.
			const loopCard = thread.locator('[data-linked-card]', { hasText: 'Customer feedback' })
			await expect(loopCard).toBeVisible({ timeout: 10_000 })
			await expect(loopCard).toContainText('Loop')
			await expect(loopCard).toContainText('Learning')
			await expect(thread.getByText('the loop', { exact: true })).toHaveCount(0)

			// The trigger card: when it fires and On, never the instruction or the raw schedule.
			const triggerCard = thread.locator('[data-linked-card]', { hasText: 'Morning sweep' })
			await expect(triggerCard).toBeVisible()
			await expect(triggerCard).toContainText('Trigger')
			await expect(triggerCard).toContainText('On')
			await expect(triggerCard).toContainText(/Runs /)
			await expect(thread).not.toContainText(INSTRUCTION)
			await expect(thread).not.toContainText('0 9 * * 1-5')

			// The loop linked inside the sentence is a chip; it is already drawn as a card below.
			const chip = thread.getByRole('link', { name: /^Loop, learning: Customer feedback/ }).first()
			await expect(chip).toBeVisible()

			for (const card of [loopCard, triggerCard]) {
				const box = await card.boundingBox()
				expect(box?.width ?? 0).toBeLessThanOrEqual(460)
			}
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			const preview = page.locator('[data-linked-preview]')
			if (vp.width === VIEWPORTS.desktop.width) {
				// A pointer device at 640px or wider: hover opens the same card as a preview.
				await chip.hover()
				await expect(preview).toBeVisible()
				await expect(preview).toContainText('Customer feedback')
				await expect(preview).toContainText('Every customer who gives feedback')
				for (const colorScheme of ['light', 'dark'] as const) {
					await page.evaluate(
						(dark) => document.documentElement.classList.toggle('dark', dark),
						colorScheme === 'dark',
					)
					// Colours ease over 180ms; let them settle before the picture.
					await page.waitForTimeout(400)
					await page.screenshot({
						path: `test-results/linked-loop-trigger-${vp.width}-${colorScheme}.png`,
					})
				}
				await page.mouse.move(5, 5)
				await expect(preview).toHaveCount(0)
			} else {
				await chip.hover()
				await expect(preview).toHaveCount(0)
				await page.screenshot({ path: `test-results/linked-loop-trigger-${vp.width}-light.png` })
			}
		})
	}
})
