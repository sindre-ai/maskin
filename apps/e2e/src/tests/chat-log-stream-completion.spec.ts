import { expect, test } from '../fixtures/auth.fixture'
import { E2E_AGENT_SERVER_SECRET } from '../helpers/api.helper'
import {
	type LiveChatSession,
	countSessionRequests,
	openLiveChat,
	seedLiveChatSession,
	userLine,
	warmUpStream,
} from '../helpers/chat-log-stream.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Session-completion behaviour on the SSE log stream.
 *
 * When the agent-server writes a terminal `system` line (`Session completed`),
 * the dev route emits `event: done` and stops the stream
 * (apps/dev/src/routes/sessions.ts:898-905). The client must then:
 *
 *   1. tear the EventSource down for that session — no reconnect attempt;
 *   2. kill the 2s fast poll (the session is over; there is nothing to chase);
 *   3. leave EXACTLY ONE backstop fetch, `DONE_GRACE_TICK_MS` (30s) later, to
 *      catch any final rows that landed between the last poll and `done`.
 *
 * The single tick is the whole point: a repeating interval would be a pure cost
 * on a finished session, and no tick at all once froze a transcript with a
 * trailing line missing. Both failure modes are silent, so the assertions below
 * bracket the window from three sides — nothing before the tick, exactly one at
 * it, and still one long after it.
 *
 * The poll counter is reset the moment `done` is expected to have landed, so
 * `poll === 1` means "one fetch since completion", not "one fetch ever".
 */

test.describe('Chats — SSE log stream session completion', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`stream closes and the poll stops after one grace tick at ${vp.label}`, async ({
			page,
			account,
		}) => {
			test.setTimeout(120_000)
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const title = `E2E completion ${vp.width}`
			const live: LiveChatSession = await seedLiveChatSession(page, account, title)
			const requests = countSessionRequests(page, live.sessionId)

			const { activitySteps } = await openLiveChat(page, account, live, title)

			// The segment anchor, so the live turn renders.
			await account.api.postSessionLogs(
				live.sessionId,
				[{ stream: 'stdout', content: userLine(live.triggerMessageId) }],
				E2E_AGENT_SERVER_SECRET,
			)

			// Warm up until the stream demonstrably delivers a row, so the
			// `done` frame below cannot land on a connection that is still
			// coming up — see `warmUpStream`. A stream that missed the terminal
			// line would never tear down, and the fast poll would keep running.
			await warmUpStream(page, account, live.sessionId, [
				'mcp__maskin__warmup_tool',
				'mcp__maskin__warmup_tool_b',
			])
			await expect(activitySteps.getByText('Using mcp__maskin__warmup_tool')).toBeVisible({
				timeout: 10_000,
			})

			// The terminal line. The route matches it by prefix and emits `done`.
			await account.api.postSessionLogs(
				live.sessionId,
				[{ stream: 'system', content: 'Session completed' }],
				E2E_AGENT_SERVER_SECRET,
			)

			// Let `done` arrive and the hook react (fast poll dies, grace tick
			// arms at ~now + 30s). Then reset so every count below is "since
			// completion".
			await page.waitForTimeout(6_000)
			requests.reset()

			// Before the tick is due: the 2s fast poll must already be dead, so
			// nothing at all should be fetched. The tick cannot fire before 30s
			// after `done`, and `done` landed before the reset above — so 24s in
			// there is at least a 6s margin.
			await page.waitForTimeout(18_000)
			expect(requests.counts.poll).toBe(0)

			// The tick is due ~30s after `done`; by 44s it must have fired
			// exactly once, with the same margin on the far side.
			await page.waitForTimeout(20_000)
			expect(requests.counts.poll).toBe(1)

			// Long after: still one. A second tick would mean the "one-shot" is
			// an interval, which is the regression this guards.
			await page.waitForTimeout(12_000)
			expect(requests.counts.poll).toBe(1)

			// No reconnect attempt after `done` — the stream was torn down, not
			// re-established. The counter was zeroed at the reset above, once
			// `done` had landed and the teardown had happened, so any stream
			// request since would land here. Measured as "none since the reset"
			// rather than an absolute, because StrictMode can double the
			// initial mount.
			expect(requests.counts.sse).toBe(0)

			await page.screenshot({ path: `/tmp/e2e-shots/completion-${vp.width}.png` })
		})
	}
})
