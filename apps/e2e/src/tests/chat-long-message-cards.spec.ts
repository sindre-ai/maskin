import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import {
	DRAFT_IN_CAP_MESSAGE,
	LONG_AGENT_MESSAGES,
	type LongAgentMessage,
	PROTOTYPE_LONG_MESSAGE,
	renderLongMessage,
} from '../fixtures/long-agent-messages'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * Long agent messages, the clutter case of "Chat preview cards": 5 to 10 links in one reply must
 * stay a message. At 375, 1024 and 1440 wide there is no sideways scroll, no card or chip scrolls
 * inside itself, at most 3 cards are drawn and every other link is a chip. The Linked drawer shows
 * the same card as the transcript for a plain object.
 */

const WIDTHS = [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]
const MAX_CARDS = 3

// A chip's accessible name is "{type}, {status}: {title}"; a card's is its own text, with no comma.
const CHIP_NAME = /^(Bet|Task|Insight|Knowledge), [^:]+: /

interface Expected {
	message: LongAgentMessage
	/** Reference cards drawn in place. */
	cards: number
	/** Links to objects drawn as a chip. */
	chips: number
}

const CASES: Expected[] = [
	{ message: LONG_AGENT_MESSAGES[0], cards: 0, chips: 6 },
	{ message: LONG_AGENT_MESSAGES[1], cards: 1, chips: 6 },
	{ message: LONG_AGENT_MESSAGES[2], cards: 3, chips: 7 },
	{ message: PROTOTYPE_LONG_MESSAGE, cards: 3, chips: 3 },
]

type Account = { api: TestAPI; workspaceId: string }

/** Makes one object per fixture entry and a chat with the message posted by a second agent. */
async function chatWithLongMessage(account: Account, message: LongAgentMessage) {
	const ws = account.workspaceId
	const ids: Record<string, string> = {}
	for (const o of message.objects) {
		// A task cannot start past todo or backlog; it is moved to the status the message shows.
		const startsAtTodo = o.type === 'task' && o.status !== 'backlog'
		const made = await account.api.createObject(ws, {
			type: o.type,
			title: o.title,
			status: startsAtTodo ? 'todo' : o.status,
			content: o.content,
			...(o.draft ? { metadata: { kind: 'linkedin_message', to: 'Fixture recipient' } } : {}),
		})
		if (startsAtTodo && o.status !== 'todo') {
			await account.api.updateObject(made.id, ws, { status: o.status })
		}
		ids[o.key] = made.id
	}
	const agent = await account.api.createAgentActor(`Long Message QA ${Date.now()}`)
	await account.api.addWorkspaceMember(ws, agent.id)
	const conversation = await account.api.createConversation(ws, {
		title: `E2E ${message.name}`,
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
		content: renderLongMessage(message, ws, ids),
	})
	return { conversation, ids }
}

/** The page, and the element holding the cards (the transcript or the drawer's list), do not scroll sideways. */
async function expectNoSidewaysScroll(page: Page, label: string, holder: string) {
	await page.waitForTimeout(200)
	const widths = await page.evaluate((sel) => {
		const el = document.querySelector(sel)
		return {
			page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			holder: el ? el.scrollWidth - el.clientWidth : Number.NaN,
		}
	}, holder)
	expect(widths.page, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(0)
	expect(widths.holder, `${label}: the cards' container scrolls sideways`).toBeLessThanOrEqual(1)
}

const THREAD = '[data-testid="thread-messages"]'
const DRAWER_LIST = '[aria-label="Linked items"]'

/** Every element in a card or chip whose own overflow is a vertical scroll that has something to scroll. */
async function innerScrollers(page: Page, selector: string): Promise<string[]> {
	return page.evaluate((sel) => {
		const found: string[] = []
		for (const root of document.querySelectorAll(sel)) {
			for (const el of [root, ...root.querySelectorAll('*')]) {
				const overflowY = getComputedStyle(el).overflowY
				if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
					found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`)
				}
			}
		}
		return found
	}, selector)
}

test.describe('Chat — a long agent message with many links stays readable', () => {
	for (const vp of WIDTHS) {
		for (const { message, cards: expectedCards, chips: expectedChips } of CASES) {
			test(`${message.name} at ${vp.width}px`, async ({ page, account }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				const { conversation } = await chatWithLongMessage(account, message)

				await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
				const thread = page.getByTestId('thread-messages')
				await expect(thread).toBeVisible({ timeout: 10_000 })

				const cards = thread.locator('[data-linked-card]')
				const chips = thread.getByRole('link', { name: CHIP_NAME })
				// Every link is looked up before it turns into a card or a chip: wait for the last one.
				await expect(cards).toHaveCount(expectedCards, { timeout: 15_000 })
				await expect(chips).toHaveCount(expectedChips, { timeout: 15_000 })
				expect(expectedCards).toBeLessThanOrEqual(MAX_CARDS)
				// No link is left as bare text: skeletons are gone.
				await expect(thread.locator('[data-linked-card][aria-busy="true"]')).toHaveCount(0)

				await expectNoSidewaysScroll(page, `${message.name} @ ${vp.width}`, THREAD)
				expect(
					await innerScrollers(page, '[data-linked-card], a[aria-label]'),
					`${message.name} @ ${vp.width}: a card or chip scrolls inside itself`,
				).toEqual([])

				for (const colorScheme of ['light', 'dark'] as const) {
					await page.emulateMedia({ colorScheme })
					await expectNoSidewaysScroll(page, `${message.name} @ ${vp.width} ${colorScheme}`, THREAD)
				}
			})
		}

		test(`a draft counts toward the cap of 3 cards at ${vp.width}px`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await chatWithLongMessage(account, DRAFT_IN_CAP_MESSAGE)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })

			// The draft and the bet and task around it are the three cards; the insight and the
			// page after them are chips, not a fourth and fifth card. The draft's approval card
			// carries the same marker as a reference card, so the three are counted together.
			const cards = thread.locator('[data-linked-card]')
			await expect(cards).toHaveCount(MAX_CARDS, { timeout: 15_000 })
			await expect(cards.filter({ hasText: 'Raft for the quiet weekend' })).toHaveCount(1)
			await expect(cards.filter({ hasText: 'Note to the dock manager' })).toHaveCount(1)
			await expect(cards.filter({ hasText: 'Count the spare keys' })).toHaveCount(1)
			await expect(thread.getByRole('link', { name: CHIP_NAME })).toHaveCount(2)
			await expect(
				thread.getByRole('link', { name: /^Insight, New: Handover notes get lost on Fridays/ }),
			).toBeVisible()
			await expect(
				thread.getByRole('link', { name: /^Knowledge, Draft: How the weekend rota works/ }),
			).toBeVisible()
			await expectNoSidewaysScroll(page, `draft in cap @ ${vp.width}`, THREAD)
		})

		test(`the Linked drawer shows the transcript's card for a plain object at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await chatWithLongMessage(account, LONG_AGENT_MESSAGES[2])
			const ws = account.workspaceId

			await page.goto(`/${ws}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread.locator('[data-linked-card]')).toHaveCount(3, { timeout: 15_000 })
			const inThread = thread.locator('[data-linked-card]', { hasText: 'North pier signup flow' })
			await expect(inThread).toHaveCount(1)
			const threadText = ((await inThread.innerText()) ?? '').replace(/\s+/g, ' ')

			await page.getByRole('button', { name: 'Open Overview' }).click()
			const linkedTab = page.getByRole('tab', { name: /Items/ })
			await expect(linkedTab).toContainText('10')
			await linkedTab.click()

			const list = page.getByRole('list', { name: 'Linked items' })
			// One card per linked object, drawn by the same component as in the transcript.
			await expect(list.locator('[data-linked-card]')).toHaveCount(10, { timeout: 15_000 })
			const inDrawer = list.locator('[data-linked-card]', { hasText: 'North pier signup flow' })
			await expect(inDrawer).toHaveCount(1)
			// Same type, status, title and text (the "Updated" time may read differently).
			// The type eyebrow is drawn in capitals ("BET"), so compare without case.
			for (const part of ['Bet', 'active', 'North pier signup flow']) {
				expect(threadText.toLowerCase()).toContain(part.toLowerCase())
				await expect(inDrawer).toContainText(new RegExp(part, 'i'))
			}
			await expect(inDrawer).toContainText('New people reach their first chat in under two minutes')
			expect(await innerScrollers(page, '[data-linked-id] [data-linked-card]')).toEqual([])
			await expectNoSidewaysScroll(page, `drawer @ ${vp.width}`, DRAWER_LIST)
		})
	}
})
