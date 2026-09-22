import { expect, test } from '../fixtures/auth.fixture'
import { E2E_AGENT_SERVER_SECRET } from '../helpers/api.helper'
import {
	type LiveChatSession,
	countSessionRequests,
	openLiveChat,
	seedLiveChatSession,
	setPageVisibility,
	toolUseLine,
	userLine,
} from '../helpers/chat-log-stream.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Focus-scoping on the chat route.
 *
 * The app-wide default is `refetchOnWindowFocus: false`
 * (apps/web/src/lib/query.ts:30). A live chat is the one place that uniquely
 * has something new to show when the tab comes back, so the chat/logs query
 * opts in per-query — and only that query.
 *
 * Two things make this observable rather than theoretical:
 *
 *   - TanStack skips an interval fetch while the page is unfocused
 *     (queryObserver.js:215 gates on `focusManager.isFocused()`), and
 *     `isFocused()` reads `document.visibilityState`. So with the visibility
 *     getter overridden to `hidden`, the 2s poll timer runs but fetches
 *     nothing — a hard zero across the hidden window.
 *   - On restore, `focusManager.onFocus()` fires and the opted-in query
 *     catches up immediately, while queries that kept the default do not.
 *
 * The contrast is the evidence: zero polls across the hidden window, then a
 * poll within a second and a half of restore, and no unrelated endpoint
 * touched in the same window.
 *
 * Honesty note (Rail 8): `useEvents` and `useNotifications` are not mounted on
 * this route, so their absence from the counters here proves nothing. The unit
 * test's QueryClient-cache assertion is the authority for those two. The hooks
 * genuinely mounted here are `useObjects` (command palette) and `useBilling`
 * (trial banner), and those are real assertions.
 */

test.describe('Chats — SSE log stream backgrounded-tab return', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`chat/logs catches up on visibility restore, unrelated queries do not, at ${vp.label}`, async ({
			page,
			account,
		}) => {
			test.setTimeout(120_000)
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const title = `E2E backgrounded ${vp.width}`
			const live: LiveChatSession = await seedLiveChatSession(page, account, title)
			const requests = countSessionRequests(page, live.sessionId)

			const { activitySteps } = await openLiveChat(page, account, live, title)

			await account.api.postSessionLogs(
				live.sessionId,
				[
					{ stream: 'stdout', content: userLine(live.triggerMessageId) },
					{ stream: 'stdout', content: toolUseLine('mcp__maskin__warmup_tool') },
				],
				E2E_AGENT_SERVER_SECRET,
			)
			await expect(activitySteps.getByText('Using mcp__maskin__warmup_tool')).toBeVisible({
				timeout: 10_000,
			})

			// Background the tab, then let in-flight work drain so the counters
			// below describe the hidden window alone.
			await setPageVisibility(page, 'hidden')
			await page.waitForTimeout(3_000)
			requests.reset()

			// Across a window longer than the 2s fast poll: zero fetches, because
			// TanStack gates the interval fetch behind focus.
			await page.waitForTimeout(33_000)
			expect(requests.counts.poll).toBe(0)

			// Restore focus. The opted-in chat/logs query must catch up promptly.
			await setPageVisibility(page, 'visible')
			await expect
				.poll(() => requests.counts.poll, { timeout: 5_000, intervals: [250] })
				.toBeGreaterThan(0)

			// Same visibility event, unrelated endpoints untouched. Generous
			// window so a late straggler still counts as a failure.
			await page.waitForTimeout(3_000)
			expect(requests.unrelatedTotal()).toBe(0)

			await page.screenshot({ path: `/tmp/e2e-shots/backgrounded-${vp.width}.png` })
		})
	}
})
