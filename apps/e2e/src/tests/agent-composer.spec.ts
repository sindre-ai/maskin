import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — bottom composer', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		// Mockup 2506–2516: "Message {name}…". Sebk reported twice that messages
		// sent from here didn't appear in the Chats list — sessions ran but no
		// conversation row was created. The fix routes the send through
		// createConversation so the message lands on the conversation surface;
		// this spec pins that contract at every ship-gate viewport.
		test(`messages the agent and starts a chat conversation @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Cass Composer')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// A real POST would spin the conversation-responder up plus a
			// container launch, which the web stack in CI has no runtime for.
			// Fulfil the conversation POST so the wiring is exercised end-to-end
			// through the UI; the follow-up detail fetch is stubbed shallow so
			// the target chat page renders without a live backend.
			let createdPayload: {
				title: string
				participant_actor_ids: string[]
				initial_message: string
			} | null = null
			const conversationId = 'conv-new'
			await page.route('**/api/conversations', async (route) => {
				if (route.request().method() !== 'POST') {
					await route.fallback()
					return
				}
				const body = route.request().postDataJSON() as {
					title: string
					participant_actor_ids: string[]
					initial_message: string
				}
				createdPayload = body
				const now = '2026-01-01T00:00:00Z'
				await route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({
						id: conversationId,
						workspaceId: account.workspaceId,
						title: body.title,
						createdBy: account.actorId,
						lastMessageAt: now,
						pinned: false,
						archived: false,
						createdAt: now,
						updatedAt: now,
						participants: body.participant_actor_ids.map((id) => ({
							actorId: id,
							actorName: id === agent.id ? 'Cass Composer' : 'You',
							actorType: id === agent.id ? 'agent' : 'human',
							addedBy: account.actorId,
							addedAt: now,
							leftAt: null,
							pinned: false,
							archived: false,
							lastReadMessageId: null,
						})),
						unreadCount: 0,
					}),
				})
			})
			await page.route(`**/api/conversations/${conversationId}`, async (route) => {
				if (route.request().method() !== 'GET') {
					await route.fallback()
					return
				}
				const now = '2026-01-01T00:00:00Z'
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						id: conversationId,
						workspaceId: account.workspaceId,
						title: 'Sweep the backlog before standup',
						createdBy: account.actorId,
						lastMessageAt: now,
						pinned: false,
						archived: false,
						createdAt: now,
						updatedAt: now,
						participants: [
							{
								actorId: account.actorId,
								actorName: 'You',
								actorType: 'human',
								addedBy: account.actorId,
								addedAt: now,
								leftAt: null,
								pinned: false,
								archived: false,
								lastReadMessageId: null,
							},
							{
								actorId: agent.id,
								actorName: 'Cass Composer',
								actorType: 'agent',
								addedBy: account.actorId,
								addedAt: now,
								leftAt: null,
								pinned: false,
								archived: false,
								lastReadMessageId: null,
							},
						],
						unreadCount: 0,
					}),
				})
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const composer = page.getByTestId('agent-composer')
			await expect(composer).toBeVisible({ timeout: 10_000 })

			// Reachable on touch and legible in both colour schemes.
			const input = composer.getByLabel('Message Cass Composer')
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(input).toBeVisible()
				await expect(composer.getByText('Starts a new chat')).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			await input.fill('Sweep the backlog before standup')
			await composer.getByRole('button', { name: 'Send message' }).click()

			await expect(page.getByText(/picked it up/)).toBeVisible()
			if (!createdPayload) throw new Error('POST /api/conversations never fired')
			const payload = createdPayload as {
				title: string
				participant_actor_ids: string[]
				initial_message: string
			}
			expect(payload.initial_message).toBe('Sweep the backlog before standup')
			expect(payload.participant_actor_ids).toEqual([agent.id])
			// The composer navigates to the newly-created chat so the user
			// lands on the reply thread rather than the agent page.
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/${conversationId}`))
		})
	}
})
