import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

const WIDTHS = [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]
const GONE = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

test.describe('Chat — your own message carries the object card', () => {
	for (const vp of WIDTHS) {
		test(`own messages with a card in the bubble, a lone card, chips and a deleted object at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ws = account.workspaceId
			const make = (type: string, title: string, status: string) =>
				account.api.createObject(ws, {
					type,
					title,
					status,
					content: `**${title}** explains what this ${type} is about, in a few plain words.`,
				})
			const bet = await make('bet', 'Own card bet', 'active')
			const task = await make('task', 'Own card task', 'todo')
			const insight = await make('insight', 'Own card insight', 'new')

			const agent = await account.api.createAgentActor(`Own Card QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E own message object card',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			// Your own text is plain: only a bare address of this workspace counts as a link.
			const address = (id: string) => `https://maskin.io/${ws}/objects/${id}`

			const post = (content: string) =>
				account.api.postConversationMessage(conversation.id, ws, { content })
			await post(`Is the bet on track?\n${address(bet.id)}\nThanks.`)
			await post(address(task.id))
			await post(`Quick look at ${address(insight.id)} please`)
			await post(`The bet again\n${address(bet.id)}`)
			await post(`An old one\n${address(GONE)}`)

			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			const message = (text: string) =>
				thread.locator('[data-message-id]').filter({ hasText: text })

			// Words and a card on its own line: one plate, the card nested under the words.
			const nested = message('Is the bet on track?')
			await expect(nested.locator('[data-linked-card]')).toBeVisible({ timeout: 10_000 })
			await expect(nested.locator('.bg-primary [data-linked-card]')).toHaveCount(1)
			await expect(nested).toContainText('Own card bet')
			await expect(nested).toContainText('Thanks.')
			await expect(nested.locator('.bg-primary')).toHaveCount(1)

			// Only a link: the card is the message, no plate around it.
			const alone = message('Own card task')
			const lone = alone.locator('[data-linked-card]')
			await expect(lone).toBeVisible()
			await expect(alone.locator('.bg-primary')).toHaveCount(0)
			await expect(lone.locator('a')).toHaveAttribute('target', '_blank')

			// A link in a sentence is a chip, and the same object again is a chip too.
			const sentence = message('Quick look at')
			await expect(sentence.locator('[data-linked-card]')).toHaveCount(0)
			await expect(
				sentence.getByRole('link', { name: /^Insight, New: Own card insight/ }),
			).toHaveAttribute('target', '_blank')
			const again = message('The bet again')
			await expect(again.locator('[data-linked-card]')).toHaveCount(0)
			await expect(again.getByRole('link', { name: /^Bet, Active: Own card bet/ })).toBeVisible()

			// An object that is gone reads Deleted object.
			await expect(message('An old one').getByText('Deleted object')).toBeVisible()

			// A lone card fills the column up to 460px (about 343px on a phone, not a 68vw sliver). The 8px
			// gutter for the session marker bar sits inside that box, so a card with the bar is 452px.
			const box = await lone.boundingBox()
			expect(box?.width ?? 0).toBeLessThanOrEqual(461)
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(Math.min(460, vp.width * 0.8) - 9)

			// A bubble that holds a card is min(520px, 88% of the column) wide and the card fills it.
			const plate = await nested.locator('.bg-primary').boundingBox()
			const nestedCard = await nested.locator('[data-linked-card]').boundingBox()
			expect(plate?.width ?? 0).toBeLessThanOrEqual(521)
			const threadWidth = (await thread.boundingBox())?.width ?? 0
			expect(plate?.width ?? 0).toBeGreaterThanOrEqual(Math.min(520, (threadWidth - 56) * 0.88) - 1)
			expect(nestedCard?.width ?? 0).toBeGreaterThanOrEqual((plate?.width ?? 0) - 31)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			// The app reads its theme from the "dark" class on the page, not from the browser's colour scheme.
			for (const theme of ['light', 'dark'] as const) {
				await page.evaluate(
					(dark) => document.documentElement.classList.toggle('dark', dark),
					theme === 'dark',
				)
				await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
				await expect(lone).toBeVisible()
				await expect(nested.locator('[data-linked-card]')).toBeVisible()
			}
		})
	}
})
