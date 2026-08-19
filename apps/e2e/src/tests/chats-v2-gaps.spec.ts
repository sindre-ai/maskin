import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The Chats gaps closed against the v2 mockup:
 *  - 545–549 the older-conversations affordance stops claiming to be loading
 *  - 660–679 an agent message carrying a ```chart block renders as a data-viz card
 *  - 761–771 `/` opens the "TURN THIS INTO AN OBJECT" type list
 *
 * `chats-v2.spec.ts` owns the archived empty-state fix (542–544) alongside the
 * rest of the filter-menu coverage. Everything here runs against the real
 * `/api/conversations` routes via TestAPI.
 */

const CHART_MESSAGE = [
	'Signup completion by step:',
	'',
	'```chart',
	JSON.stringify({
		type: 'bar',
		x: 'step',
		series: ['completed'],
		data: [
			{ step: 'Email', completed: 820 },
			{ step: 'Profile', completed: 410 },
			{ step: 'Invite', completed: 120 },
		],
		caption: 'Drop-off concentrates on step two.',
	}),
	'```',
].join('\n')

test.describe('Chats v2 — list affordances', () => {
	test('the older-conversations row only claims to load while a page is in flight', async ({
		page,
		account,
	}) => {
		await account.api.createConversation(account.workspaceId, {
			title: `Gap list ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'A conversation to list',
		})

		await page.goto(`/${account.workspaceId}/chats`)
		const list = page.getByTestId('conversation-list')
		await expect(list).toBeVisible({ timeout: 15_000 })

		// One page of history: the list just ends — no scroll affordance and no
		// permanent spinner label left behind.
		await expect(list.getByText('Loading older conversations…')).toHaveCount(0)
		await expect(list.getByText('Older conversations load as you scroll')).toHaveCount(0)
	})
})

test.describe('Chats v2 — agent data-viz card', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders a chart block from an agent message @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor(`Chart Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Chart chat ${Date.now()}`,
				participant_actor_ids: [agent.id],
				initial_message: 'How is signup doing?',
			})
			// Posted as the agent — the viz card is an *incoming* message
			// affordance; the viewer's own plate stays plain text.
			const agentApi = new TestAPI(agent.api_key)
			await agentApi.postConversationMessage(conversation.id, account.workspaceId, {
				content: CHART_MESSAGE,
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByTestId('thread-messages')).toBeVisible({ timeout: 15_000 })

			// The fenced spec becomes the bounded visual, not a literal code block.
			// Scoped to the transcript: the left pane's row snippet is the raw
			// message, caption JSON and all, so a page-wide match resolves to two
			// elements at every viewport wide enough to show the list.
			const transcript = page.getByTestId('thread-messages')
			await expect(transcript.getByText('Drop-off concentrates on step two.')).toBeVisible({
				timeout: 15_000,
			})
			await expect(transcript.getByText('"type": "bar"')).toHaveCount(0)

			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)
		})
	}
})

test.describe('Chats v2 — turn this into an object', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`typing / opens the create list @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Slash chat ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Let us shape this',
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const composer = page.getByLabel('Message this conversation')
			await expect(composer).toBeVisible({ timeout: 15_000 })

			await composer.click()
			await composer.pressSequentially('/')

			const menu = page.getByLabel('Turn this into an object')
			await expect(menu).toBeVisible({ timeout: 10_000 })
			await expect(menu.getByRole('button', { name: /Bets/ })).toBeVisible()
			await expect(menu.getByRole('button', { name: /Insights/ })).toBeVisible()

			await page.keyboard.press('Escape')
			await expect(menu).toHaveCount(0)
		})
	}
})
