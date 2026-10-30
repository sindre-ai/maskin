import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const TITLES = ['Draw the fold', 'Wire the button', 'Check the keyboard']

async function openChatWithCards(
	account: { workspaceId: string; api: TestAPI },
	page: Page,
	count: number,
) {
	const ws = account.workspaceId
	const agent = await account.api.createAgentActor(`Fold QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(ws, agent.id)
	const links: string[] = []
	for (const title of TITLES.slice(0, count)) {
		const task = await account.api.createObject(ws, {
			type: 'task',
			title,
			status: 'todo',
			content: `The text of ${title}.`,
			driver: agent.id,
		})
		links.push(`[${title}](/${ws}/objects/${task.id})`)
	}
	const conversation = await account.api.createConversation(ws, {
		title: 'E2E card fold',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
		content: `Three things to look at:\n\n${links.join('\n\n')}\n\nThat is all.`,
	})
	await page.goto(`/${ws}/chats/${conversation.id}`)
	const thread = page.getByTestId('thread-messages')
	const cards = thread.locator('[data-linked-card]')
	await expect(cards).toHaveCount(count, { timeout: 10_000 })
	return { ws, thread, cards, conversationUrl: page.url() }
}

test.describe('Chat — a card on its own line folds to one row', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`fold and unfold by mouse at ${vp.width}px, light and dark`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { cards, conversationUrl } = await openChatWithCards(account, page, 3)

			// Every card starts open: one link and a fold button beside it, not inside it.
			for (const index of [0, 1, 2]) {
				const card = cards.nth(index)
				await expect(card.getByRole('link')).toHaveCount(1)
				await expect(card.getByRole('button', { name: 'Fold card' })).toHaveAttribute(
					'aria-expanded',
					'true',
				)
				await expect(card.locator('a button')).toHaveCount(0)
				await expect(card).toContainText(`The text of ${TITLES[index]}.`)
			}

			for (const scheme of ['light', 'dark'] as const) {
				await page.evaluate(
					(dark) => document.documentElement.classList.toggle('dark', dark),
					scheme === 'dark',
				)
				const first = cards.first()
				const openHeight = (await first.boundingBox())?.height ?? 0
				await first.getByRole('button', { name: 'Fold card' }).click()

				// Folded: one row, 40px high, the title on one line, nothing else opened.
				const row = first.getByRole('button', { name: `Unfold card: ${TITLES[0]}` })
				await expect(row).toBeVisible()
				await expect(row).toHaveAttribute('aria-expanded', 'false')
				const folded = await first.boundingBox()
				expect(folded?.height).toBe(40)
				expect(openHeight).toBeGreaterThan(80)
				await expect(first.getByRole('link')).toHaveCount(0)
				await expect(first).not.toContainText(`The text of ${TITLES[0]}.`)
				await expect(page).toHaveURL(conversationUrl)

				// The neighbours keep their state, and the page never scrolls sideways.
				await expect(cards.nth(1).getByRole('button', { name: 'Fold card' })).toBeVisible()
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				)
				expect(overflow).toBeLessThanOrEqual(0)
				await page.screenshot({ path: `test-results/card-fold-${vp.width}-${scheme}.png` })

				await row.click()
				await expect(first.getByRole('button', { name: 'Fold card' })).toBeVisible()
				expect((await first.boundingBox())?.height).toBeCloseTo(openHeight, 0)
			}
		})
	}

	test('keyboard: Tab reaches the link, then the button; Enter and Space fold and unfold, focus stays', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })
		const { cards, conversationUrl } = await openChatWithCards(account, page, 1)
		const card = cards.first()
		const link = card.getByRole('link')
		const fold = card.getByRole('button', { name: 'Fold card' })

		await link.focus()
		await page.keyboard.press('Tab')
		await expect(fold).toBeFocused()

		await page.keyboard.press('Enter')
		const row = card.getByRole('button', { name: `Unfold card: ${TITLES[0]}` })
		await expect(row).toBeFocused()
		expect((await card.boundingBox())?.height).toBe(40)

		await page.keyboard.press('Space')
		await expect(fold).toBeFocused()
		await page.keyboard.press('Space')
		await expect(row).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(fold).toBeFocused()
		await expect(page).toHaveURL(conversationUrl)
	})

	test('the link still opens the object', async ({ page, account }) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })
		const { ws, cards } = await openChatWithCards(account, page, 1)
		await cards.first().getByRole('link').click()
		await expect(page).toHaveURL(new RegExp(`/${ws}/objects/`))
	})
})
