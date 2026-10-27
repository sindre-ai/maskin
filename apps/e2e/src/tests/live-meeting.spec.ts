import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * What a live call leaves in its thread: a row per real change, then a summary
 * card whose button opens the Transcript view. The messages are posted the way the
 * server will post them (metadata.source 'voice', kind 'receipt' /
 * 'receipt_summary'), so no WebRTC call is needed. The live panel and bar need a
 * real microphone and the voice backend; they are covered by the component tests
 * in apps/web (live-call-surface.test.tsx).
 */

const VOICE_SESSION_ID = '5d6f3c1e-0b0e-4c4b-8a53-6f8a2d3b7c10'

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

async function threadWithCall(account: { api: TestAPI; workspaceId: string }) {
	const agent = await account.api.createAgentActor(`Live Meeting QA ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const task = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Backfill cancelled bookings',
		status: 'todo',
	})
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E live meeting',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	const post = new TestAPI(agent.api_key)
	const voice = { source: 'voice', voice_session_id: VOICE_SESSION_ID }
	const send = (content: string, metadata: Record<string, unknown>) =>
		post.postConversationMessage(conversation.id, account.workspaceId, {
			content,
			metadata: { ...voice, ...metadata },
		})

	await send('Could you check the cancel flow?', {})
	await send('Opened the task', {
		kind: 'receipt',
		event: 'opened_task',
		object_id: task.id,
		text: 'A cancel after a create is accepted as a new delivery',
		t: 12,
		outcome: 'ran',
	})
	await send('Moved to review', {
		kind: 'receipt',
		event: 'moved_to_review',
		object_id: task.id,
		text: 'Aggregate review + open bet PR + manual test',
		t: 16,
		outcome: 'ran',
	})
	await send('Webhook dedup review with the Developer', {
		kind: 'receipt_summary',
		duration_seconds: 3604,
		decided: ['Backfill cancelled bookings'],
		created: [{ type: 'task', title: 'Backfill cancelled bookings', object_id: task.id }],
		next: ['Code Reviewer picks up the PR today'],
		not_done: [],
	})
	return { conversation, task }
}

test.describe('Live meeting — what the call leaves in the thread', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows event rows, a summary card and the Transcript view @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation, task } = await threadWithCall(account)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })

				// Event rows: call-relative time, kind label, text.
				await expect(thread.getByText('0:12', { exact: true })).toBeVisible({ timeout: 10_000 })
				await expect(thread.getByText('Opened task', { exact: true })).toBeVisible()
				await expect(
					thread.getByText('A cancel after a create is accepted as a new delivery'),
				).toBeVisible()
				await expect(thread.getByText('Moved to review', { exact: true })).toBeVisible()

				// Summary card.
				const card = thread.getByRole('article', { name: 'Live meeting summary' })
				await expect(card).toBeVisible()
				await expect(card.getByText('1:00:04', { exact: true })).toBeVisible()
				await expect(card.getByText('Decided · 1')).toBeVisible()
				await expect(card.getByText('Created · 1')).toBeVisible()
				await expect(card.getByText('Next', { exact: true })).toBeVisible()
				await assertNoHorizontalOverflow(page, `${vp.label} ${scheme}`)
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// The spoken lines are not in the thread: only the summary card's
			// Transcript view shows them.
			await expect(thread.getByText('Could you check the cancel flow?')).toHaveCount(0)
			await expect(thread.getByTestId('voice-call-boundary').first()).toBeVisible()

			const card = thread.getByRole('article', { name: 'Live meeting summary' })
			await card.getByRole('button', { name: 'Read transcript' }).click()
			const view = page.getByRole('dialog', { name: 'Transcript' })
			await expect(view).toBeVisible()
			await expect(view.getByText('Could you check the cancel flow?')).toBeVisible()
			await expect(view.getByText('0:00', { exact: true })).toBeVisible()
			await expect(view.getByText('You', { exact: true })).toBeVisible()
			const box = await view.boundingBox()
			if (vp.width < 700) {
				// Full screen on narrow viewports.
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(vp.width - 1)
			} else {
				// A drawer on the right otherwise.
				expect(box?.width ?? 0).toBeLessThan(vp.width)
			}
			await assertNoHorizontalOverflow(page, `${vp.label} transcript`)
			await page.keyboard.press('Escape')
			await expect(view).toHaveCount(0)

			// Clicking a row opens the object.
			await thread.getByText('Aggregate review + open bet PR + manual test').click()
			await expect(page).toHaveURL(new RegExp(`/objects/${task.id}`))
		})
	}
})
