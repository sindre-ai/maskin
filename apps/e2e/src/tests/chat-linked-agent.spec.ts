import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

// The picture goes into the HTML report as an attachment (apps/e2e/playwright-report, uploaded by
// CI as the playwright-report-N artifact), because test-results/ is not uploaded.
async function picture(page: Page, testInfo: TestInfo, name: string) {
	// Colours ease over 180ms; let them settle before the picture.
	await page.waitForTimeout(400)
	await testInfo.attach(name, {
		body: await page.screenshot({ path: `test-results/${name}.png` }),
		contentType: 'image/png',
	})
}

test.describe('Chat — a linked agent draws like an object and a loop', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`one message mixes an object, an agent and a loop as card, chip and preview at ${vp.width}px`, async ({
			page,
			account,
		}, testInfo) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agentName = `Unfurl QA Agent ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName)
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
			// A pending session counts as active, so the agent reads Working now.
			await account.api.createSession(ws, {
				actor_id: agent.id,
				action_prompt: 'Write the weekly digest',
				auto_start: false,
			})
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E linked agent',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: [
					`The task is [here](/${ws}/objects/${task.id}), [the agent](/${ws}/agents/${agent.id}) owns it and the loop [runs it](/${ws}/loops/${loop.id}).`,
					`[the agent](/${ws}/agents/${agent.id})`,
					`[the loop](/${ws}/loops/${loop.id})`,
				].join('\n\n'),
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			// The agent link alone on its line is a card with the agent's own name, not the link text.
			const agentCard = thread.locator('[data-linked-card]', { hasText: agentName })
			await expect(agentCard).toBeVisible({ timeout: 10_000 })
			await expect(agentCard).toContainText('Agent')
			await expect(agentCard).toContainText('Working now')
			await expect(thread.getByText('the agent', { exact: true })).toHaveCount(0)

			// The loop card sits next to it, drawn the same way.
			const loopCard = thread.locator('[data-linked-card]', { hasText: 'Customer feedback' })
			await expect(loopCard).toBeVisible()
			await expect(loopCard).toContainText('Loop')

			// The agent linked inside the sentence is a chip, with the state in its name.
			const chip = thread.getByRole('link', { name: `Agent, Working now: ${agentName}` }).first()
			await expect(chip).toBeVisible()
			// The object linked inside the sentence is a chip too.
			await expect(
				thread.getByRole('link', { name: /^Task, To do: Write the weekly digest/ }).first(),
			).toBeVisible()

			for (const card of [agentCard, loopCard]) {
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
				await expect(preview).toContainText(agentName)
				await expect(preview).toContainText('Working now')
				await picture(page, testInfo, `linked-agent-${vp.width}-light`)
				await page.evaluate(() => document.documentElement.classList.add('dark'))
				await picture(page, testInfo, `linked-agent-${vp.width}-dark`)
				await page.mouse.move(5, 5)
				await expect(preview).toHaveCount(0)
			} else {
				await chip.hover()
				await expect(preview).toHaveCount(0)
				await picture(page, testInfo, `linked-agent-${vp.width}-light`)
				await page.evaluate(() => document.documentElement.classList.add('dark'))
				await picture(page, testInfo, `linked-agent-${vp.width}-dark`)
			}
		})
	}
})
