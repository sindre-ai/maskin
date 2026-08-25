import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'

/**
 * For You — "Dismiss all" against the real backend, no mocks.
 *
 * Dismissing is marking read: the `···` menu's row has to move every card's
 * high-water mark, not just hide it optimistically. The unread feed is
 * mentions-only, so the agent @-mentions the viewer to put anything in it.
 */
test('the ··· menu\u2019s "Dismiss all" really marks every card read', async ({
	page,
	account,
}) => {
	const agent = await account.api.createAgentActor(`Reviewer ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const agentApi = new TestAPI(agent.api_key)

	const a = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Merge the trigger settings rewrite?',
		status: 'in_review',
		content: 'Needs a human click-through.',
	})
	const b = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Finish the edit card, or cut it?',
		status: 'in_review',
		content: 'One failed check.',
	})
	// The unread feed is mentions-only, so the agent has to @-mention the viewer.
	const mention = async (entityId: string, content: string) => {
		const res = await fetch('http://localhost:5173/api/events', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${agent.api_key}`,
				'X-Workspace-Id': account.workspaceId,
			},
			body: JSON.stringify({ entity_id: entityId, content, mentions: [account.actorId] }),
		})
		if (!res.ok) throw new Error(`mention failed: ${res.status} ${await res.text()}`)
	}
	await mention(a.id, 'Ready for you.')
	await mention(b.id, 'Ready too.')

	await page.goto(`/${account.workspaceId}`)
	await expect(page.getByTestId('foryou-feed-card')).toHaveCount(2)

	const readFailures: string[] = []
	page.on('response', async (response) => {
		if (response.url().includes('/api/subscriptions/read') && !response.ok()) {
			readFailures.push(`${response.status()} ${await response.text().catch(() => '')}`)
		}
	})

	await page.getByRole('button', { name: 'Feed actions' }).click()
	await page.getByRole('menuitem', { name: /^Dismiss all( \d+)?$/ }).click()

	await expect(page.getByTestId('foryou-feed-card')).toHaveCount(0)
	// Dismissing is marking read, so it survives a reload — a card that comes
	// back is the mutation having failed behind an optimistic hide.
	await page.reload()
	await expect(page.getByText('Feed cleared')).toBeVisible()
	await expect(page.getByTestId('foryou-feed-card')).toHaveCount(0)
	expect(readFailures, `mark-read calls failed: ${readFailures.join(' | ')}`).toEqual([])
})
