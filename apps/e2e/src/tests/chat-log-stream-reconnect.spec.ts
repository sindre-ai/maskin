import { expect, test } from '../fixtures/auth.fixture'
import { E2E_AGENT_SERVER_SECRET } from '../helpers/api.helper'
import {
	type LiveChatSession,
	type StreamAccount,
	countSessionRequests,
	openLiveChat,
	readPersistedCursor,
	seedLiveChatSession,
	toolUseLine,
	userLine,
	warmUpStream,
} from '../helpers/chat-log-stream.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Reconnect recovery on the SSE log stream.
 *
 * The stream can drop mid-turn (network blip, proxy timeout, navigation). On
 * reconnect `fetch-event-source` resumes from the `Last-Event-ID` cursor the
 * client persisted, and the server replays every row after that id
 * (apps/dev/src/routes/sessions.ts:847-863). The client then Set-dedups by row
 * id in `mergeSessionLogs`, so a replay that overlaps what is already rendered
 * must converge on the same transcript rather than duplicating it.
 *
 * How the drop is forced — and why not `context.setOffline`:
 *
 * The obvious lever is `page.context().setOffline(true)`, but it does NOT tear
 * down an established SSE stream in this Chromium. That was verified, not
 * assumed: with the browser offline the stream kept delivering rows, the
 * "missed" line rendered while supposedly disconnected, and no reconnect ever
 * fired. `setOffline` gates the network stack at *request* time; a stream that
 * is already open is not a request any more. Routing (`page.route` + abort)
 * has the same blind spot — it intercepts requests as they are issued, so it
 * can block a *new* connection but cannot kill a live one.
 *
 * So the drop here is a real one: a full navigation away from the chat
 * unmounts the thread, whose cleanup aborts the EventSource. The resume cursor
 * lives in `sessionStorage` (session-log-stream.ts:14-23), so it survives that
 * navigation — which is precisely the property a reconnect depends on. The
 * missed line is posted while the chat is unmounted, and the return trip must
 * resume from the cursor and replay it.
 *
 * Three assertions carry the weight, because a false pass here would be silent:
 *   - the line posted while unmounted must be absent before the return and
 *     present after it (the gap guard);
 *   - the reconnect's `Last-Event-ID` must equal the cursor persisted before
 *     the drop — without it the client would restart at the live edge and
 *     silently lose the gap;
 *   - each `Using <tool>` step must render exactly once (the duplicate guard).
 */

/** Every distinct `tool_use` name in the session's canonical transcript, in row order. */
async function canonicalToolNames(account: StreamAccount, sessionId: string): Promise<string[]> {
	const rows = await account.api.getSessionLogs(sessionId, account.workspaceId)
	const names: string[] = []
	for (const row of rows) {
		if (row.stream !== 'stdout') continue
		try {
			const envelope = JSON.parse(row.content) as {
				message?: { content?: Array<{ type?: string; name?: string }> }
			}
			for (const block of envelope.message?.content ?? []) {
				if (block.type === 'tool_use' && typeof block.name === 'string') names.push(block.name)
			}
		} catch {
			// Non-JSON stdout lines carry no tool_use block; ignore them.
		}
	}
	return names
}

test.describe('Chats — SSE log stream reconnect recovery', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`transcript matches the canonical log after a real stream drop at ${vp.label}`, async ({
			page,
			account,
		}) => {
			test.setTimeout(120_000)
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const title = `E2E reconnect ${vp.width}`
			const live: LiveChatSession = await seedLiveChatSession(page, account, title)
			// Instrument BEFORE navigating so the initial SSE connection is counted.
			const requests = countSessionRequests(page, live.sessionId)

			const { activitySteps } = await openLiveChat(page, account, live, title)

			// The segment anchor. The `user` envelope is the only thing that
			// opens a new activity segment, so the live turn renders. Whichever
			// channel delivers it, `mergeSessionLogs` sorts by row id, so the
			// transcript order is identical either way.
			await account.api.postSessionLogs(
				live.sessionId,
				[{ stream: 'stdout', content: userLine(live.triggerMessageId) }],
				E2E_AGENT_SERVER_SECRET,
			)

			// Warm up until the stream demonstrably delivers a row — see
			// `warmUpStream` for why one post is not enough. Two names so a
			// single lost race does not fail the run.
			await warmUpStream(page, account, live.sessionId, [
				'mcp__maskin__before_drop',
				'mcp__maskin__before_drop_b',
			])
			await expect(activitySteps.getByText('Using mcp__maskin__before_drop')).toBeVisible({
				timeout: 10_000,
			})

			const sseBeforeDrop = requests.counts.sse
			expect(sseBeforeDrop).toBeGreaterThan(0)

			// The resume cursor, read with the stream idle: nothing is posted
			// between here and the navigation, and only the stream writes this
			// key, so it cannot move before the drop.
			const cursor = await readPersistedCursor(page, live.sessionId)
			expect(cursor).toBeTruthy()

			// The drop: a full navigation away unmounts the thread, aborting the
			// EventSource. The chats list does not mount the activity hook
			// (`useSessionActivityLogs` reaches the DOM only via
			// `useConversationActivity` in the thread), so nothing on the away
			// route keeps a stream open for this session.
			await page.goto(`/${account.workspaceId}/chats`)
			await expect(page).not.toHaveURL(new RegExp(live.conversationId))

			// Post the line the dropped stream cannot deliver.
			await account.api.postSessionLogs(
				live.sessionId,
				[{ stream: 'stdout', content: toolUseLine('mcp__maskin__while_dropped') }],
				E2E_AGENT_SERVER_SECRET,
			)
			await page.waitForTimeout(2_000)

			// Return. The thread remounts, opens a fresh stream, and must resume
			// from the persisted cursor so the server replays the missed row.
			await page.goto(`/${account.workspaceId}/chats/${live.conversationId}`)
			await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 })

			// Gap guard: the missed line arrives.
			await expect(activitySteps.getByText('Using mcp__maskin__while_dropped')).toBeVisible({
				timeout: 30_000,
			})

			// Proof the drop was real and the reconnect resumed: a fresh SSE
			// connection was opened, and it carried the cursor persisted before
			// the drop — which is what makes the server replay the missed row.
			expect(requests.counts.sse).toBeGreaterThan(sseBeforeDrop)
			expect(requests.lastStreamCursor()).toBe(cursor)

			// Duplicate guard: every tool_use in the canonical transcript
			// renders exactly once, and the warmed-up step is still single.
			const canonical = await canonicalToolNames(account, live.sessionId)
			const distinct = [...new Set(canonical)]
			expect(distinct).toEqual(
				expect.arrayContaining(['mcp__maskin__before_drop', 'mcp__maskin__while_dropped']),
			)
			for (const name of distinct) {
				expect(canonical.filter((n) => n === name)).toHaveLength(1)
				await expect(activitySteps.getByText(`Using ${name}`)).toHaveCount(1)
			}

			await page.screenshot({ path: `/tmp/e2e-shots/reconnect-${vp.width}.png` })
		})
	}
})
