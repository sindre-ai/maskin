import { expect, test } from '../fixtures/auth.fixture'
import { E2E_AGENT_SERVER_SECRET } from '../helpers/api.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for the live chat transcript fed by the SSE log stream
 * (`GET /api/sessions/:id/logs/stream`) rather than by polling.
 *
 * The web E2E stack has no container runtime, so a genuinely running session
 * cannot be created. The spec instead seeds a real `pending` session row
 * (`auto_start: false`) and then presents it to the UI as `running` with a
 * route mock — the same shape agent-sessions.spec.ts uses. The log lines are
 * real: they go through the production ingest endpoint
 * (`POST /api/internal/agent-servers/sessions/:id/logs`), which inserts them
 * and emits on the in-process `log` bus the SSE handler reads, so the whole
 * POST → emit → SSE frame → store merge → render path is exercised end to end.
 *
 * The transcript does NOT render raw log lines. It renders summarised steps
 * derived by `segmentActivityByMessage` / `describeEvent`
 * (apps/web/src/components/agents/session-log-transcript.tsx), so the
 * assertions target the derived step text — `Using <tool>` for a `tool_use`
 * content block, `Thinking…` for a `thinking` block — not the posted payload.
 */

/** A `tool_use` assistant envelope whose step summary is `Using <name>`. */
function toolUseLine(name: string, id = `toolu_${name}`): string {
	return JSON.stringify({
		type: 'assistant',
		message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] },
	})
}

/** A `thinking` assistant envelope whose step summary is `Thinking…`. */
function thinkingLine(id = 'think_1'): string {
	return JSON.stringify({
		type: 'assistant',
		message: { id: `msg_${id}`, content: [{ type: 'thinking', thinking: 'Weighing options' }] },
	})
}

/**
 * The `user` envelope carrying `maskin_message_id` is the only thing that opens
 * a new activity segment (`segmentActivityByMessage` pushes a segment and
 * returns on it). Without it the assistant lines land in `unassigned` and the
 * live turn never anchors to a conversation message.
 *
 * The newest stdout envelope must also NOT end in a `result`, or
 * `isSessionIdleAwaitingInput` reads the session as idle and the live turn is
 * suppressed — hence no result line anywhere in this spec.
 */
function userLine(conversationMessageId: number): string {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'Kick off the live turn' },
		maskin_message_id: conversationMessageId,
	})
}

test.describe('Chats — live transcript over the SSE log stream', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders each newly ingested log line in under 500ms at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// A trial workspace caps seats; the agent must join as a member for
			// the conversation to route a turn to it.
			await grantPlanHeadroom(account.apiKey, account.workspaceId)
			const agent = await account.api.createAgentActor(`E2E Live Log Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E live log stream',
				participant_actor_ids: [agent.id],
			})
			// The trigger message id is what anchors the live turn in the
			// transcript, so it must be a real conversation message.
			const trigger = await account.api.postConversationMessage(
				conversation.id,
				account.workspaceId,
				{ content: 'Start the live turn' },
			)

			const session = await account.api.createSession(account.workspaceId, {
				actor_id: agent.id,
				action_prompt: 'Live log stream E2E',
				config: {
					conversation: { conversation_id: conversation.id, message_id: trigger.id },
				},
				auto_start: false,
			})

			// Present the seeded `pending` row as `running` so the transcript
			// treats it as live and subscribes to its SSE stream, and drop every
			// other session for this workspace. The glob's `*` stops at the first
			// `/`, so `/api/sessions/:id/logs` and `/api/sessions/:id/logs/stream`
			// still reach the real API.
			//
			// The filtering is load-bearing, not tidiness. Posting the trigger
			// message runs `evaluateAndRespond`, which spawns a real interactive
			// session for the same (conversation, agent) pair. In this stack that
			// session fails instantly (no LLM credentials), and the transcript
			// keeps only the NEWEST session per actor — so the responder's failed
			// row can outrank the seeded one and render the "failed to start"
			// card instead of the live turn. The two rows are created ~3ms apart,
			// so leaving both visible makes the spec a coin flip.
			await page.route('**/api/sessions*', async (route) => {
				const response = await route.fetch()
				let body: unknown
				try {
					body = await response.json()
				} catch {
					await route.fulfill({ response })
					return
				}
				const sessions = Array.isArray(body) ? body : []
				await route.fulfill({
					response,
					json: sessions
						.filter((s) => (s as { id?: string }).id === session.id)
						.map((s) => ({ ...(s as Record<string, unknown>), status: 'running' })),
				})
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByRole('heading', { name: 'E2E live log stream' })).toBeVisible({
				timeout: 10_000,
			})

			const liveTurn = page.getByTestId('message-activity-live')
			const activitySteps = liveTurn.getByLabel('Agent activity')

			// Warm-up: opening the segment and proving the stream is live before
			// the timed assertion, so the 500ms budget measures the ingest →
			// render path rather than first-connection setup.
			await account.api.postSessionLogs(
				session.id,
				[
					{ stream: 'stdout', content: userLine(trigger.id) },
					{ stream: 'stdout', content: toolUseLine('mcp__maskin__warmup_tool') },
				],
				E2E_AGENT_SERVER_SECRET,
			)
			await expect(activitySteps.getByText('Using mcp__maskin__warmup_tool')).toBeVisible({
				timeout: 10_000,
			})

			// Timed: a fresh line posted to the ingest endpoint must reach the
			// rendered transcript within 500ms.
			const startedAt = Date.now()
			await account.api.postSessionLogs(
				session.id,
				[
					{ stream: 'stdout', content: toolUseLine('mcp__maskin__live_tool') },
					{ stream: 'stdout', content: thinkingLine() },
				],
				E2E_AGENT_SERVER_SECRET,
			)
			await expect(activitySteps.getByText('Using mcp__maskin__live_tool')).toBeVisible({
				timeout: 5_000,
			})
			await expect(activitySteps.getByText('Thinking…')).toBeVisible({ timeout: 5_000 })
			expect(Date.now() - startedAt).toBeLessThan(500)
		})
	}
})
