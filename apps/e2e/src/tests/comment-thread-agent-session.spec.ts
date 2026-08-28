import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// One agent session per comment THREAD, not per comment.
//
// Comment-triggered sessions are now interactive and long-lived
// (apps/dev/src/services/comment-responder.ts): a follow-up comment in the same
// thread is delivered into the running session instead of spawning a second
// container. The visible consequence, and what this spec pins, is that a thread
// with several comments shows exactly ONE agent activity card, rendered at the
// end of the thread rather than under whichever comment happened to trigger it.
//
// The session is mocked at the API boundary — a real one needs a container,
// which CI has no way to run.

interface MockSession {
	id: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	status: string
	containerId: string | null
	actionPrompt: string
	config: Record<string, unknown> | null
	result: Record<string, unknown> | null
	snapshotPath: string | null
	interactive: boolean
	startedAt: string | null
	completedAt: string | null
	timeoutAt: string | null
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
	currentActivity: string | null
}

function buildThreadSession(params: {
	actorId: string
	workspaceId: string
	objectId: string
	threadRootEventId: number
	seedCommentEventId: number
}): MockSession {
	const now = new Date().toISOString()
	return {
		id: '11111111-1111-4111-8111-111111111111',
		workspaceId: params.workspaceId,
		actorId: params.actorId,
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'seed',
		interactive: true,
		config: {
			interactive: true,
			comment_thread: {
				object_id: params.objectId,
				thread_root_event_id: params.threadRootEventId,
				seed_comment_event_id: params.seedCommentEventId,
			},
			mention: {
				object_id: params.objectId,
				comment_event_id: params.seedCommentEventId,
				commenter_actor_id: params.actorId,
			},
		},
		result: null,
		snapshotPath: null,
		startedAt: now,
		completedAt: null,
		timeoutAt: null,
		createdBy: params.actorId,
		createdAt: now,
		updatedAt: now,
		currentActivity: null,
	}
}

test.describe('Comment thread agent session', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows one session card for a multi-comment thread at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Thread session bet',
				status: 'signal',
			})
			const root = await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: 'Root question for the agent',
			})
			// Two follow-ups: under the old one-shot model these would each have
			// carried their own session card.
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: 'First follow-up',
				parent_event_id: Number(root.id),
			})
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: 'Second follow-up',
				parent_event_id: Number(root.id),
			})

			const session = buildThreadSession({
				actorId: account.actorId,
				workspaceId: account.workspaceId,
				objectId: bet.id,
				threadRootEventId: Number(root.id),
				seedCommentEventId: Number(root.id),
			})

			// Only the mention-scoped session list is stubbed; every other session
			// query keeps hitting the real API.
			await page.route('**/api/sessions?**', async (route) => {
				const url = new URL(route.request().url())
				if (!url.searchParams.has('mention_object_id')) return route.fallback()
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify([session]),
				})
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Thread session bet' })).toBeVisible(
				{ timeout: 10000 },
			)

			// Every comment in the thread is present…
			await expect(page.getByText('Root question for the agent')).toBeVisible()
			await expect(page.getByText('First follow-up')).toBeVisible()
			await expect(page.getByText('Second follow-up')).toBeVisible()

			// …but only one activity card, keyed on the thread root rather than on
			// any single comment.
			const stopButton = page.getByRole('button', { name: /Stop session|End thread session/ })
			await expect(stopButton).toHaveCount(1)
			// Reachable on touch — no hover-only reveal.
			await expect(stopButton).toBeVisible()

			// The card sits after the replies, at the end of the thread.
			const lastReplyBox = await page.getByText('Second follow-up').boundingBox()
			const cardBox = await stopButton.boundingBox()
			expect(lastReplyBox).not.toBeNull()
			expect(cardBox).not.toBeNull()
			if (lastReplyBox && cardBox) expect(cardBox.y).toBeGreaterThan(lastReplyBox.y)

			// Legible in both colour schemes — the card uses semantic tokens only.
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(stopButton).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: null })
		})
	}
})
