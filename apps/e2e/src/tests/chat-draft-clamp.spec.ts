import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * A draft in chat is cut at about 12 lines, and Approve draft stays off until Show all has been
 * used. A draft that fits has no gate. After the click the card reads Approved, waiting for send,
 * and Sent once the send is recorded. Real API for the objects; only the Sent state is faked, by
 * answering the object read with a recorded send, because no send tool runs in this stack.
 */

const WIDTHS = [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]

const LONG_LINES = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the long draft.`)
// Paragraphs, so each source line is its own line on screen.
const LONG_DRAFT = LONG_LINES.join('\n\n')
const SHORT_DRAFT = 'Hej Merethe, tak for forbindelsen.\n\nHvad arbejder I med lige nu?'

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

/** True when nothing inside the card scrolls on its own. */
async function hasNoInnerScroll(card: Locator) {
	return card.evaluate((root) =>
		[...root.querySelectorAll('*')].every((el) => {
			const { overflowY } = getComputedStyle(el)
			return overflowY !== 'auto' && overflowY !== 'scroll'
		}),
	)
}

async function createDraft(
	account: { api: TestAPI; workspaceId: string },
	title: string,
	content: string,
) {
	return account.api.createObject(account.workspaceId, {
		type: 'task',
		title,
		status: 'todo',
		content,
		metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
	})
}

async function chatWithAgentMessage(
	account: { api: TestAPI; workspaceId: string },
	content: (workspaceId: string) => string,
) {
	// Posted by a second agent actor: only the non-own branch of MessageBubble renders cards.
	const agent = await account.api.createAgentActor(`Draft Clamp QA ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E draft clamp',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
		content: content(account.workspaceId),
	})
	return conversation
}

test.describe('Chat — a long draft is clamped and gated', () => {
	for (const vp of WIDTHS) {
		test(`a draft over 12 lines is approvable only after Show all @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const draft = await createDraft(account, 'Long note to Merethe', LONG_DRAFT)
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [draft](/${ws}/objects/${draft.id}).`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await thread.getByText('Long note to Merethe').click()

			const approve = thread.getByRole('button', { name: 'Approve draft' })
			await expect(approve).toBeDisabled()
			await expect(thread.getByText('Read the full draft first')).toBeVisible()
			await expect(thread.getByText('Line 1 of the long draft.')).toBeVisible()
			// Cut off: the last line is not inside the card's visible box.
			const card = thread.locator('[data-linked-card]')
			const last = thread.getByText('Line 30 of the long draft.')
			const cutBox = await last.boundingBox()
			const cardBox = await card.boundingBox()
			expect(cutBox && cardBox && cutBox.y > cardBox.y + cardBox.height).toBe(true)
			expect(await hasNoInnerScroll(card)).toBe(true)

			// A click on a disabled button does nothing.
			await approve.click({ force: true })
			await expect(thread.getByText('Approved, waiting for send')).toHaveCount(0)

			await thread.getByRole('button', { name: 'Show all' }).click()
			await expect(approve).toBeEnabled()
			await expect(thread.getByText('Read the full draft first')).toHaveCount(0)
			await expect(last).toBeVisible()
			expect(await hasNoInnerScroll(card)).toBe(true)

			await thread.getByRole('button', { name: 'Show less' }).click()
			await expect(approve).toBeDisabled()
			await thread.getByRole('button', { name: 'Show all' }).click()

			await approve.click()
			await expect(thread.getByText('Approved, waiting for send', { exact: true })).toBeVisible()
			await expect(thread.getByRole('button', { name: 'Approve draft' })).toHaveCount(0)

			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`a draft of 12 lines or fewer is approvable at once @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const draft = await createDraft(account, 'Short note to Merethe', SHORT_DRAFT)
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [draft](/${ws}/objects/${draft.id}).`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await thread.getByText('Short note to Merethe').click()

			await expect(thread.getByRole('button', { name: 'Approve draft' })).toBeEnabled()
			await expect(thread.getByRole('button', { name: 'Show all' })).toHaveCount(0)
			await expect(thread.getByText('Read the full draft first')).toHaveCount(0)

			await thread.getByRole('button', { name: 'Approve draft' }).click()
			await expect(thread.getByText('Approved, waiting for send', { exact: true })).toBeVisible()
			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`three drafts in one message each get their own Approve draft @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const titles = ['First note', 'Second note', 'Third note']
			const drafts = []
			for (const title of titles) {
				drafts.push(await createDraft(account, title, SHORT_DRAFT))
			}
			const conversation = await chatWithAgentMessage(account, (ws) =>
				drafts.map((d, i) => `Draft ${i + 1}: [${titles[i]}](/${ws}/objects/${d.id})`).join('\n\n'),
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			for (const title of titles) {
				await thread.getByText(title, { exact: true }).click()
			}

			await expect(thread.locator('[data-linked-card]')).toHaveCount(3)
			await expect(thread.getByRole('button', { name: 'Approve draft' })).toHaveCount(3)
			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`a draft whose send is recorded reads Sent @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const draft = await createDraft(account, 'Sent note to Merethe', SHORT_DRAFT)
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [draft](/${ws}/objects/${draft.id}).`,
			)
			await page.route(`**/api/objects/${draft.id}`, async (route) => {
				if (route.request().method() !== 'GET') return route.continue()
				const response = await route.fetch()
				const json = await response.json()
				if (json.preview) json.preview.delivery = { state: 'sent', at: null }
				return route.fulfill({ response, json })
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await thread.getByText('Sent note to Merethe').click()

			await expect(thread.getByText('Sent', { exact: true })).toBeVisible()
			await expect(thread.getByRole('button', { name: 'Approve draft' })).toHaveCount(0)
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})
