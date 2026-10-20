import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the draft card an agent puts in chat via `post_draft`.
 *
 * The card message is injected at the transport, as in
 * agent-integration-connect-card.spec.ts: `metadata.draft` is backend-owned and
 * `stripServerOwnedMetadata` removes it from anything a client posts, so a
 * client-seeded card is exactly what must NOT be renderable. The task it points
 * at is real, though, so every edit, approval and undo below goes through the real
 * `POST /objects/:id/draft` transition and is read back from the server. The write
 * path and the 409 guards are covered against Postgres in
 * apps/dev/src/__tests__/integration/draft-transition.test.ts and
 * session-draft.test.ts.
 */

const BODY = 'Hi Mette,\n\nThanks for the call. Best,\nSeb'

interface Seeded {
	conversationId: string
	taskId: string
	agentId: string
}

async function seedDraft(
	account: Parameters<Parameters<typeof test>[2]>[0]['account'],
	page: Page,
): Promise<Seeded> {
	const stamp = Date.now()
	const agent = await account.api.createAgentActor(`Drafter ${stamp}`, account.workspaceId)
	const task = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: `Approve email to Mette ${stamp}`,
		status: 'backlog',
		content: BODY,
		metadata: {
			draft_state: 'draft',
			draft_subject: 'Following up',
			draft_original_subject: 'Following up',
			draft_original_body: BODY,
			draft_approved_at: null,
		},
	})
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Draft ${stamp}`,
		participant_actor_ids: [agent.id],
		initial_message: 'Draft a follow-up to Mette',
	})

	const card = {
		id: 9201,
		conversationId: conversation.id,
		actorId: agent.id,
		actorName: agent.name,
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: `**To:** Mette Holm\n\n> ${BODY}`,
		metadata: { draft: { object_id: task.id, kind: 'email', to: 'Mette Holm, Northwind' } },
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ messages: [card], has_more: false }),
		})
	})

	return { conversationId: conversation.id, taskId: task.id, agentId: agent.id }
}

test.describe('Draft card', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`edits, approves and undoes through the server at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const { conversationId, taskId, agentId } = await seedDraft(account, page)
			await page.goto(`/${account.workspaceId}/chats/${conversationId}`)

			const body = page.getByRole('textbox', { name: 'Draft text' })
			await expect(body).toBeVisible()
			await expect(body).toHaveValue(BODY)

			// An edit saves on blur and survives a reload.
			await body.fill('Shorter note.')
			await page.getByRole('textbox', { name: 'Subject' }).click()
			await expect
				.poll(async () => (await account.api.getObject(taskId, account.workspaceId)).content)
				.toBe('Shorter note.')
			await page.reload()
			await expect(page.getByRole('textbox', { name: 'Draft text' })).toHaveValue('Shorter note.')
			await expect(page.getByText('Edited')).toBeVisible()

			// Approve is reachable on touch, records the yes, and tells the agent in the chat.
			const approve = page.getByRole('button', { name: 'Approve and send' })
			await expect(approve).toBeVisible()
			const posted = page.waitForRequest(
				(req) =>
					req.method() === 'POST' &&
					req.url().includes(`/conversations/${conversationId}/messages`),
			)
			await approve.click()

			await expect(page.getByText('Approved to send')).toBeVisible()
			const message = (await posted).postDataJSON() as {
				content: string
				metadata: { mentions: string[] }
			}
			expect(message.content).toContain(`task ${taskId}`)
			expect(message.metadata.mentions).toEqual([agentId])
			const approved = await account.api.getObject(taskId, account.workspaceId)
			expect(approved.metadata).toMatchObject({ draft_state: 'approved' })
			await expect(page.getByRole('textbox', { name: 'Draft text' })).toBeDisabled()

			// Undo reopens the draft for editing, with the text that was approved.
			await page.getByRole('button', { name: 'Undo' }).click()
			await expect(page.getByRole('button', { name: 'Approve and send' })).toBeVisible()
			await expect(page.getByRole('textbox', { name: 'Draft text' })).toBeEnabled()
			await expect(page.getByRole('textbox', { name: 'Draft text' })).toHaveValue('Shorter note.')
			expect((await account.api.getObject(taskId, account.workspaceId)).metadata).toMatchObject({
				draft_state: 'draft',
			})
		})
	}

	test('shows a refused change instead of dropping what was typed', async ({ page, account }) => {
		const { conversationId, taskId } = await seedDraft(account, page)
		await page.goto(`/${account.workspaceId}/chats/${conversationId}`)
		await expect(page.getByRole('textbox', { name: 'Draft text' })).toBeVisible()

		// Approve behind the card's back, as a second tab would: the card still
		// believes the draft is open, so its edit must be refused by the server.
		await page.route(`**/api/objects/${taskId}`, (route) => route.abort())
		await account.api.updateObject(taskId, account.workspaceId, {
			metadata: { draft_state: 'approved', draft_approved_at: new Date().toISOString() },
		})

		const body = page.getByRole('textbox', { name: 'Draft text' })
		await body.fill('Typed in a stale tab.')
		await page.getByRole('textbox', { name: 'Subject' }).click()

		// The refusal shows on the card's own message and again as a notification; the
		// card is what this test is about, so look inside the thread.
		await expect(
			page.getByTestId('thread-messages').getByText(/has changed since you opened it/),
		).toBeVisible()
		await expect(body).toHaveValue('Typed in a stale tab.')
		expect((await account.api.getObject(taskId, account.workspaceId)).content).toBe(BODY)
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`renders the card with its actions visible in ${scheme} mode`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: 375, height: 812 })
			await page.addInitScript((value) => localStorage.setItem('maskin-theme', value), scheme)
			await page.emulateMedia({ colorScheme: scheme })
			const { conversationId } = await seedDraft(account, page)
			await page.goto(`/${account.workspaceId}/chats/${conversationId}`)

			await expect(page.getByText('EMAIL DRAFT')).toBeVisible()
			await expect(page.getByRole('textbox', { name: 'Draft text' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Approve and send' })).toBeVisible()
		})
	}
})
