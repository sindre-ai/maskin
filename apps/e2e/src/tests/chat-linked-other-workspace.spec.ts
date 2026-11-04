import { randomUUID } from 'node:crypto'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { VIEWPORTS } from '../helpers/viewports'

test.describe('Chat: a link into another workspace draws as a globe placeholder', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`names the kind and the workspace, fetches nothing and opens it at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			// A trial actor may own a single workspace; this spec needs a second one to belong to.
			await grantPlanHeadroom(account.apiKey, account.workspaceId)
			const member = await account.api.createWorkspace('Acme Labs')
			const stranger = randomUUID()
			const agent = await account.api.createAgentActor(`Other Workspace QA ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const elsewhere = await account.api.createObject(member.id, {
				type: 'task',
				title: 'Secret roadmap of the other team',
				status: 'todo',
			})
			// Ids that exist nowhere: proof that nothing is looked up for the placeholder.
			const loopId = randomUUID()
			const triggerId = randomUUID()
			const strangerObjectId = randomUUID()

			const conversation = await account.api.createConversation(ws, {
				title: 'E2E other workspace',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: [
					`Compare it with [that task](/${member.id}/objects/${elsewhere.id}) and [that bet](/${stranger}/objects/${strangerObjectId}) when you can.`,
					`[the loop](/${member.id}/loops/${loopId})`,
					`[the trigger](/${stranger}/triggers/${triggerId})`,
				].join('\n\n'),
			})
			await account.api.postConversationMessage(conversation.id, ws, {
				content: `And is https://maskin.io/${member.id}/objects/${elsewhere.id} the same one?`,
			})

			const lookedUp: string[] = []
			page.on('request', (request) => {
				const url = request.url()
				// Not the objects: the chat's Linked drawer reads every /objects/ address on its own.
				for (const id of [loopId, triggerId]) {
					if (url.includes(id)) lookedUp.push(url)
				}
			})

			await page.goto(`/${ws}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')

			// Two cards, one per link alone on its line: a member workspace and a stranger's.
			const loopCard = thread.locator('[data-linked-card]', { hasText: 'Loop in Acme Labs' })
			await expect(loopCard).toBeVisible({ timeout: 10_000 })
			await expect(loopCard).toHaveAttribute('href', `/${member.id}/loops/${loopId}`)
			const triggerCard = thread.locator('[data-linked-card]', {
				hasText: 'Trigger in another workspace',
			})
			await expect(triggerCard).toBeVisible()
			await expect(triggerCard).toHaveAttribute('href', `/${stranger}/triggers/${triggerId}`)
			for (const card of [loopCard, triggerCard]) {
				await expect(card.locator('svg.lucide-globe')).toBeVisible()
				await expect(card).toHaveCSS('border-top-style', 'dashed')
				await expect(card).toHaveCSS('font-style', 'italic')
				const box = await card.boundingBox()
				expect(box?.width ?? 0).toBeLessThanOrEqual(460)
			}
			await expect(thread.getByText('the loop', { exact: true })).toHaveCount(0)

			// Two chips in the sentence; the same words, the same dashed look, no preview.
			const objectChip = thread.getByRole('link', { name: 'Object in Acme Labs' }).first()
			await expect(objectChip).toBeVisible()
			await expect(objectChip).toHaveAttribute('href', `/${member.id}/objects/${elsewhere.id}`)
			const strangerChip = thread.getByRole('link', { name: 'Object in another workspace' })
			await expect(strangerChip).toBeVisible()
			await expect(objectChip).toHaveCSS('border-top-style', 'dashed')
			await expect(objectChip).toHaveCSS('font-style', 'italic')
			await objectChip.hover()
			await expect(page.locator('[data-linked-preview]')).toHaveCount(0)
			await expect(thread).not.toContainText('Deleted object')
			await expect(thread).not.toContainText('Secret roadmap of the other team')

			// Your own message: the same chip, opening in a new tab.
			const ownChip = thread.getByRole('link', { name: 'Object in Acme Labs' }).last()
			await expect(ownChip).toHaveAttribute('target', '_blank')
			await expect(ownChip).toHaveCSS('border-top-style', 'dashed')

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
			expect(lookedUp).toEqual([])

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.evaluate(
					(dark) => document.documentElement.classList.toggle('dark', dark),
					colorScheme === 'dark',
				)
				// Colours ease over 180ms; let them settle before the picture.
				await page.waitForTimeout(400)
				await page.screenshot({
					path: `test-results/linked-other-workspace-${vp.width}-${colorScheme}.png`,
				})
			}

			// Clicking a card opens it: the other workspace's page, in the same tab.
			await loopCard.click()
			await expect(page).toHaveURL(new RegExp(`/${member.id}/loops/${loopId}`))
		})
	}
})
