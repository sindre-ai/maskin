import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for an agent's AskUserQuestion surfaced as pickable options in chat.
 *
 * The headless CLI cannot render that tool, so a PreToolUse hook posts the
 * questions to `POST /sessions/:id/ask` instead and the chat renders them —
 * see docker/agent-base/hooks/ask-user-question.sh.
 *
 * The question message is injected at the transport rather than seeded through
 * the API on purpose: `metadata.question` is backend-owned and
 * `stripServerOwnedMetadata` removes it from anything a client posts, so a
 * client-seeded question is exactly the thing that must NOT be renderable.
 * The real write path is covered against Postgres in
 * apps/dev/src/__tests__/integration/session-ask.test.ts; this spec owns the
 * rendering, the interaction, and the shape of the answer that goes back.
 */

const QUESTION_MESSAGE = {
	id: 9001,
	conversationId: '',
	actorId: 'agent-1',
	actorName: 'Chief of Staff',
	actorType: 'agent' as const,
	kind: 'message' as const,
	content:
		'How should I reach Spotify?\n- **API token** — you create a developer app\n- **No login** — curate a shareable link instead',
	metadata: {
		question: {
			session_id: '11111111-1111-1111-1111-111111111111',
			questions: [
				{
					question: 'How should I reach Spotify?',
					header: 'Spotify access',
					multi_select: false,
					options: [
						{ label: 'API token', description: 'You create a developer app' },
						{ label: 'No login', description: 'Curate a shareable link instead' },
					],
				},
			],
		},
	},
	sessionId: '11111111-1111-1111-1111-111111111111',
	createdAt: new Date().toISOString(),
	editedAt: null,
}

/** Serves the thread as a single agent message carrying a question. */
async function stubQuestionThread(page: Page, conversationId: string) {
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				messages: [{ ...QUESTION_MESSAGE, conversationId }],
				has_more: false,
			}),
		})
	})
}

test.describe('Agent question options', () => {
	test('renders and answers a question, posting the pick back to the thread', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Question ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Build me a weather playlist loop',
		})
		await stubQuestionThread(page, conversation.id)

		const posted: Array<Record<string, unknown>> = []
		await page.route('**/api/conversations/*/messages', async (route) => {
			if (route.request().method() !== 'POST') return route.continue()
			posted.push(route.request().postDataJSON())
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ ...QUESTION_MESSAGE, id: 9002, metadata: null, content: 'ok' }),
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		const send = page.getByRole('button', { name: 'Send answer' })
		await expect(send).toBeVisible()
		// Nothing picked yet — the affordance must not look ready to submit.
		await expect(send).toBeDisabled()

		await page.getByRole('button', { name: 'API token' }).click()
		await expect(page.getByRole('button', { name: 'API token' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		await expect(send).toBeEnabled()
		await send.click()

		await expect.poll(() => posted.length).toBe(1)
		expect(posted[0]?.metadata).toMatchObject({
			question_answer: {
				question_message_id: 9001,
				answers: [{ header: 'Spotify access', selected: ['API token'] }],
			},
		})
		// The agent's next turn reads only this content, so it must restate the
		// question rather than sending a bare option label.
		expect(String(posted[0]?.content)).toContain('How should I reach Spotify?')
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`options are reachable and legible at ${viewport.label}`, async ({ page, account }) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Question vp ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Build me a weather playlist loop',
			})
			await stubQuestionThread(page, conversation.id)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			// toBeVisible covers opacity and visibility, so a hover-only reveal —
			// unusable on touch — fails here rather than shipping.
			const option = page.getByRole('button', { name: 'API token' })
			await expect(option).toBeVisible()
			await expect(page.getByRole('button', { name: 'Send answer' })).toBeVisible()

			const box = await option.boundingBox()
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(28)

			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)
		})
	}

	test('the selected option stays distinguishable in light and dark mode', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Question theme ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Build me a weather playlist loop',
		})
		await stubQuestionThread(page, conversation.id)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		const chosen = page.getByRole('button', { name: 'API token' })
		const other = page.getByRole('button', { name: 'No login' })
		await chosen.click()

		// The chosen chip uses `bg-primary`, not `bg-accent` — which is near-white
		// in light mode and would make the selection invisible there. Asserting
		// the two chips differ in both schemes is what catches that regression.
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			const chosenBg = await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)
			const otherBg = await other.evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(chosenBg, `selected chip should stand out in ${colorScheme} mode`).not.toBe(otherBg)
		}
	})
})
