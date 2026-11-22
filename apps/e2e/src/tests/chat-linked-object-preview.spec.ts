import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const NOTE = 'Hej Catja, tillykke med fusionen. Hvordan bruger I AI-agenter i hverdagen?'

/** A conversation with one message from a second agent: only the non-own branch of MessageBubble draws cards. */
async function chatWithAgentMessage(
	account: { api: TestAPI; workspaceId: string },
	content: (workspaceId: string) => string,
) {
	const agent = await account.api.createAgentActor(`Preview QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E linked object preview',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
		content: content(account.workspaceId),
	})
	return conversation
}

test.describe('Chat — a message that links to a draft shows what the draft says', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the linked draft's title and text appear under the message at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// A draft an integration can deliver (it carries a `metadata.kind`) gets a card.
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'LinkedIn note to Catja',
				status: 'todo',
				content: NOTE,
				metadata: { kind: 'linkedin_message', to: 'Catja' },
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [note](/${ws}/objects/${task.id}) for approval.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			// A draft is a full card from the start: the title, Open, the text and Approve.
			await expect(thread.getByText('LinkedIn note to Catja', { exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByRole('link', { name: 'Open' })).toBeVisible()
			await expect(thread.getByText(NOTE)).toBeVisible()
			await expect(thread.getByRole('button', { name: 'Approve draft' })).toBeVisible()

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByText(NOTE)).toBeVisible()
			}
		})

		test(`a task with no kind shows its text, and nothing to approve, at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// No integration can send this (a Messenger note), so it has no `metadata.kind`.
			// It is still text a person wants to read and edit where the agent mentioned it.
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Message to Mark about testing',
				status: 'todo',
				content: NOTE,
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) =>
					`Here is the draft for Mark:\n\n[Message to Mark](/${ws}/objects/${task.id})\n\nNot sent.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await expect(thread.getByText('Message to Mark about testing', { exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByText(NOTE)).toBeVisible()
			await expect(thread.getByRole('link', { name: 'Open' })).toBeVisible()
			await expect(thread.getByRole('button', { name: 'Copy the text' })).toBeVisible()
			await expect(thread.getByRole('button', { name: /Approve/ })).toHaveCount(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByText(NOTE)).toBeVisible()
			}
		})

		test(`an insight linked inside a sentence gets a card under the message at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// A fresh workspace has no event type (createObject answers 400), so the insight stands in.
			const insight = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Webinar on product discovery',
				status: 'new',
				content: 'Public title: Product discovery with AI agents.',
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Filed: [the webinar](/${ws}/objects/${insight.id}), Wed 18 Nov, as planned.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			const card = thread.locator('[data-linked-card]')
			// The link stays in the sentence; the card sits under it, folded to its title.
			await expect(card).toBeVisible({ timeout: 10_000 })
			await expect(card).toContainText('Webinar on product discovery')
			await expect(thread.getByText('Product discovery with AI agents.')).toHaveCount(0)
			// Opening it shows the text, which can be edited in place; an insight has nothing to approve.
			await card.getByText('Webinar on product discovery').click()
			await expect(thread.getByText('Product discovery with AI agents.')).toBeVisible()
			await expect(thread.getByRole('button', { name: /Approve/ })).toHaveCount(0)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(card).toBeVisible()
			}
		})

		test(`a task in a list stays a link, so a long message does not grow into cards at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Call the dock manager',
				status: 'todo',
				content: 'Ask about the spare keys before Friday.',
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) =>
					`Open items:\n\n- [Call the dock manager](/${ws}/objects/${task.id})\n- Something else`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByRole('link', { name: /Call the dock manager/ })).toBeVisible({
				timeout: 10_000,
			})
			await page.waitForTimeout(500)
			await expect(thread.getByText('Ask about the spare keys before Friday.')).toHaveCount(0)
			await expect(thread.getByRole('button', { name: 'Copy the text' })).toHaveCount(0)
		})

		test(`a contact the message links to stays a link, with no card at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const contact = await account.api.createObject(account.workspaceId, {
				type: 'contact',
				title: 'Catja Nielsen',
				status: 'new_lead',
				content: 'Head of operations at the merged company.',
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Talk to [Catja Nielsen](/${ws}/objects/${contact.id}) first.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByRole('link', { name: 'Catja Nielsen' })).toBeVisible({
				timeout: 10_000,
			})
			// Give a card time to appear if one were going to.
			await page.waitForTimeout(500)
			await expect(thread.getByRole('button', { name: 'Expand preview' })).toHaveCount(0)
			await expect(thread.getByText('Head of operations at the merged company.')).toHaveCount(0)
		})
	}
})
