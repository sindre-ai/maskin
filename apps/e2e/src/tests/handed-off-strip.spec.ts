import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The handed-off strip is the message-level surface that lists the sub-agent
 * sessions spawned from a conversation message.
 *
 * This spec is deliberately mock-free: it drives the real POST /api/sessions
 * route with `spawned_by_message_id` and `auto_start: false`, so the session
 * persists as `pending` (QUEUED) without a container runtime — exactly the
 * state the strip must render. The WORKING → DONE transition needs the
 * container exit path and stays covered by the component tests.
 */

async function seedStrip(workspaceId: string, conversationId: string, agentApiKey: string) {
	const agentApi = new TestAPI(agentApiKey)
	const message = await agentApi.postConversationMessage(conversationId, workspaceId, {
		content: 'Handing off to a sub-agent.',
	})
	return message.id
}

test.describe('Chats v2 — handed-off strip', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders a real pending session as a QUEUED row @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agentName = `Handoff Agent ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Handoff chat ${Date.now()}`,
				participant_actor_ids: [agent.id],
				initial_message: 'Please hand this off.',
			})

			const messageId = await seedStrip(account.workspaceId, conversation.id, agent.api_key)

			await account.api.createSession(account.workspaceId, {
				actor_id: agent.id,
				action_prompt: 'Do the handed-off work.',
				conversation_id: conversation.id,
				message_id: messageId,
				auto_start: false,
				spawned_by_message_id: messageId,
			})

			// The strip is gated on the visual-layer flag; seed it for this run.
			await page.addInitScript(() => {
				localStorage.setItem('ff:handed-off-strip', 'on')
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 15_000 })

			const region = page.getByRole('region', { name: 'Handed off to sub-agents' })
			await expect(region).toBeVisible({ timeout: 15_000 })

			const row = region.getByRole('listitem', { name: `Sub-agent ${agentName}: QUEUED` })
			await expect(row).toBeVisible()
			await expect(row).toContainText('QUEUED')
		})
	}
})

test.describe('Chats v2 — handed-off strip (light + dark)', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the QUEUED row is visible in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })

			const agentName = `Handoff Agent ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Handoff chat ${Date.now()}`,
				participant_actor_ids: [agent.id],
				initial_message: 'Please hand this off.',
			})

			const messageId = await seedStrip(account.workspaceId, conversation.id, agent.api_key)

			await account.api.createSession(account.workspaceId, {
				actor_id: agent.id,
				action_prompt: 'Do the handed-off work.',
				conversation_id: conversation.id,
				message_id: messageId,
				auto_start: false,
				spawned_by_message_id: messageId,
			})

			await page.addInitScript(() => {
				localStorage.setItem('ff:handed-off-strip', 'on')
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const region = page.getByRole('region', { name: 'Handed off to sub-agents' })
			await expect(region).toBeVisible({ timeout: 15_000 })

			const row = region.getByRole('listitem', { name: `Sub-agent ${agentName}: QUEUED` })
			await expect(row).toBeVisible()
		})
	}
})
