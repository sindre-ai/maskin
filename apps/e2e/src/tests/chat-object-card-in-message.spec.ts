import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const WIDTHS = [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]
const GONE = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

test.describe('Chat — a link to an object is a card or a chip with type, status and owner', () => {
	for (const vp of WIDTHS) {
		test(`one agent message mixing cards, chips and a deleted object at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor(`Card QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const make = (type: string, title: string, status: string, extra = {}) =>
				account.api.createObject(account.workspaceId, {
					type,
					title,
					status,
					content: `**${title}** explains what this ${type} is about, in a few plain words.`,
					...extra,
				})
			const bet = await make('bet', 'Chat preview cards', 'active', {
				driver: agent.id,
				metadata: { priority: 'P2' },
			})
			const task = await make('task', 'Draw the card', 'todo', { driver: agent.id })
			const insight = await make('insight', 'Links read as bare text', 'new')
			const knowledge = await make('knowledge', 'How cards work', 'draft')
			const spare = await make('task', 'A fourth card', 'backlog')

			const ws = account.workspaceId
			const url = (id: string) => `/${ws}/objects/${id}`
			// The first paragraph reads: sentence, card, sentence.
			const body = [
				`Here is the plan.\n[Chat preview cards](${url(bet.id)})\nAnd [the task](${url(task.id)}) shows who has it.`,
				`[Links read as bare text](${url(insight.id)})`,
				`- In a list: [the same bet](${url(bet.id)})`,
				`> Quoted: [the insight](${url(insight.id)})`,
				`[How cards work](${url(knowledge.id)})`,
				`[A fourth card](${url(spare.id)})`,
				`Gone: [an old one](${url(GONE)}).`,
			].join('\n\n')

			const conversation = await account.api.createConversation(ws, {
				title: 'E2E object card in message',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: body,
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			const cards = thread.locator('[data-linked-card]')
			// Three cards at most: the bet, the insight and the knowledge page.
			await expect(cards.first()).toBeVisible({ timeout: 10_000 })
			await expect(cards.filter({ hasText: 'Chat preview cards' })).toHaveCount(1)
			await expect(cards.filter({ hasText: 'Links read as bare text' })).toHaveCount(1)
			await expect(cards.filter({ hasText: 'How cards work' })).toHaveCount(1)
			await expect(cards).toHaveCount(3)

			// What the card shows: type, status, priority, text and owner, from the object itself.
			const betCard = cards.filter({ hasText: 'Chat preview cards' })
			await expect(betCard).toContainText('Bet')
			await expect(betCard).toContainText('P2')
			await expect(betCard).toContainText('explains what this bet is about')
			await expect(betCard).toContainText('Card QA Agent')
			await expect(cards.filter({ hasText: 'How cards work' })).toContainText('Unassigned')

			// Chips: a link in a sentence, in a list and in a quote, the fourth link on its own line.
			await expect(thread.getByRole('link', { name: /^Task, To do: Draw the card/ })).toBeVisible()
			await expect(
				thread.getByRole('link', { name: /^Bet, Active: Chat preview cards/ }),
			).toHaveCount(1)
			await expect(
				thread.getByRole('link', { name: /^Task, Backlog: A fourth card/ }),
			).toBeVisible()
			await expect(thread.getByText('Deleted object')).toBeVisible()

			// Order: sentence, card, sentence.
			const order = await thread.evaluate((el) => {
				const text = el.textContent ?? ''
				return [
					text.indexOf('Here is the plan.'),
					text.indexOf('Chat preview cards'),
					text.indexOf('And'),
				]
			})
			expect(order[0]).toBeLessThan(order[1])
			expect(order[1]).toBeLessThan(order[2])

			// A card is one link, up to 460px wide; nothing scrolls sideways.
			const box = await betCard.boundingBox()
			expect(box?.width ?? 0).toBeLessThanOrEqual(460)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(betCard).toBeVisible()
			}
		})
	}
})
