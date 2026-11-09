import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { E2E_AGENT_SERVER_SECRET, type TestAPI } from '../helpers/api.helper'
import { toolUseLine, userLine } from '../helpers/chat-log-stream.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * One agent, two live sessions in one chat: the main chat's and a thread's.
 *
 * The working row and its Stop button must belong to the place they were started in: the
 * thread pane shows only the thread's session, the main chat only the main one, and Stop in
 * one never reaches the other.
 *
 * The web E2E stack has no container runtime, so, as in chat-live-log-stream.spec.ts, the
 * sessions are real `pending` rows (`auto_start: false`) that a route mock presents as
 * `running`, with the thread session carrying the thread's root id. The log lines go through
 * the real ingest endpoint. Stop is intercepted, since there is no container to stop, and the
 * session id each click sends is what the test asserts.
 */

const pane = (page: Page) => page.locator('[aria-label="Thread"]')
const timeline = (page: Page) => page.getByTestId('thread-messages')

async function seedMainAndThreadSessions(
	account: { api: TestAPI; workspaceId: string; apiKey: string },
	title: string,
) {
	await grantPlanHeadroom(account.apiKey, account.workspaceId)
	const agent = await account.api.createAgentActor(`E2E Thread Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title,
		participant_actor_ids: [agent.id],
	})
	const post = (content: string, thread_root_id?: number) =>
		account.api.postConversationMessage(conversation.id, account.workspaceId, {
			content,
			thread_root_id,
		})
	const root = await post('Thread root')
	const threadMessage = await post('A question in the thread', root.id)
	const mainMessage = await post('A question in the main chat')

	const startSession = (messageId: number) =>
		account.api.createSession(account.workspaceId, {
			actor_id: agent.id,
			action_prompt: 'Per-thread activity E2E',
			config: { conversation: { conversation_id: conversation.id, message_id: messageId } },
			auto_start: false,
		})
	const threadSession = await startSession(threadMessage.id)
	const mainSession = await startSession(mainMessage.id)

	for (const [session, messageId] of [
		[threadSession, threadMessage.id],
		[mainSession, mainMessage.id],
	] as const) {
		await account.api.postSessionLogs(
			session.id,
			[
				{ stream: 'stdout', content: userLine(messageId) },
				{ stream: 'stdout', content: toolUseLine('search_objects') },
			],
			E2E_AGENT_SERVER_SECRET,
		)
	}

	return {
		conversationId: conversation.id,
		rootId: root.id,
		threadSessionId: threadSession.id,
		mainSessionId: mainSession.id,
	}
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Agent activity per thread at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('each place shows only its own session, and Stop reaches only that session', async ({
			page,
			account,
		}, testInfo) => {
			const title = `E2E per-thread activity ${Date.now()}`
			const seeded = await seedMainAndThreadSessions(account, title)

			// Present the two seeded rows as running, the thread one tagged with its root. The
			// responder's own sessions (spawned by posting the messages above) are filtered out.
			await page.route('**/api/sessions*', async (route) => {
				const response = await route.fetch()
				let body: unknown
				try {
					body = await response.json()
				} catch {
					await route.fulfill({ response })
					return
				}
				const sessions = (Array.isArray(body) ? body : []) as Record<string, unknown>[]
				await route.fulfill({
					response,
					json: sessions
						.filter((s) => s.id === seeded.threadSessionId || s.id === seeded.mainSessionId)
						.map((s) => ({
							...s,
							status: 'running',
							threadRootId: s.id === seeded.threadSessionId ? seeded.rootId : null,
						})),
				})
			})
			const stopped: string[] = []
			await page.route('**/api/sessions/*/stop', async (route) => {
				stopped.push(route.request().url().split('/sessions/')[1]?.split('/')[0] ?? '')
				await route.fulfill({ json: { id: stopped.at(-1), status: 'running' } })
			})

			await page.goto(
				`/${account.workspaceId}/chats/${seeded.conversationId}?thread=${seeded.rootId}`,
			)
			await expect(pane(page)).toBeVisible({ timeout: 10_000 })

			const liveInPane = pane(page).getByTestId('message-activity-live')
			const liveInMain = timeline(page).getByTestId('message-activity-live')
			await expect(liveInPane).toHaveCount(1)
			await expect(liveInMain).toHaveCount(1)
			await testInfo.attach(`thread-open-${vp.width}`, {
				body: await page.screenshot(),
				contentType: 'image/png',
			})

			// Stop in the thread reaches the thread's session only.
			await liveInPane.getByRole('button', { name: 'Stop' }).click()
			await expect.poll(() => stopped).toEqual([seeded.threadSessionId])

			// Close the thread, then Stop in the main chat reaches the main session only.
			await pane(page).getByRole('button', { name: 'Close thread' }).click()
			await expect(pane(page)).toBeHidden()
			await expect(liveInMain).toHaveCount(1)
			await testInfo.attach(`thread-closed-${vp.width}`, {
				body: await page.screenshot(),
				contentType: 'image/png',
			})
			await liveInMain.getByRole('button', { name: 'Stop' }).click()
			await expect.poll(() => stopped).toEqual([seeded.threadSessionId, seeded.mainSessionId])
		})
	})
}
