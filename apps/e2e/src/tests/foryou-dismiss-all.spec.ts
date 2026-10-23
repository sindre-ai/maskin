import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'

/**
 * For You — "Dismiss all" against the real backend, no mocks.
 *
 * Dismissing is marking read: the `···` menu's row has to move every card's
 * high-water mark, not just hide it optimistically. For You is the Chief of
 * Staff's curated list, so each card needs a `for_you` notification pointing at
 * the comment that carries the ask.
 */
test('the ··· menu\u2019s "Dismiss all" really marks every card read', async ({
	page,
	account,
}) => {
	// Only the Chief of Staff may curate For You items, and it is found by name. The workspace
	// already has one whose key the test cannot read, so move it aside and make this agent it.
	const existing = await account.api.listWorkspaceActors(account.workspaceId)
	for (const actor of existing.filter((a) => a.type === 'agent' && a.name === 'Chief of Staff')) {
		await account.api.updateActor(actor.id, { name: `Former Chief of Staff ${Date.now()}` })
	}
	const agent = await account.api.createAgentActor('Chief of Staff')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const agentApi = new TestAPI(agent.api_key)

	const a = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Merge the trigger settings rewrite?',
		status: 'todo',
		content: 'Needs a human click-through.',
	})
	const b = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Finish the edit card, or cut it?',
		status: 'todo',
		content: 'One failed check.',
	})
	// The API rejects tasks created at in_review, so move them after creation.
	await account.api.updateObject(a.id, account.workspaceId, { status: 'in_review' })
	await account.api.updateObject(b.id, account.workspaceId, { status: 'in_review' })
	// The agent raises the ask, then curates it onto the viewer's list.
	const curate = async (entityId: string, headline: string, rank: number) => {
		const res = await fetch('http://localhost:5173/api/events', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${agent.api_key}`,
				'X-Workspace-Id': account.workspaceId,
			},
			body: JSON.stringify({
				entity_id: entityId,
				content: headline,
				mentions: [account.actorId],
			}),
		})
		if (!res.ok) throw new Error(`mention failed: ${res.status} ${await res.text()}`)
		const comment = (await res.json()) as { id: number }
		await agentApi.createNotification(account.workspaceId, {
			type: 'needs_input',
			title: headline,
			metadata: { kind: 'for_you', rank, headline, source_comment_id: comment.id },
			source_actor_id: agent.id,
			target_actor_id: account.actorId,
			object_id: entityId,
		})
	}
	await curate(a.id, 'Ready for you.', 1)
	await curate(b.id, 'Ready too.', 2)

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
