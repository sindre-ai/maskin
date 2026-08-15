import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers the shared agent-reply renderer: inline chart + live task checklist.
// Both surfaces (For You unread cards and bet detail) render through
// ActivityComment, so verifying once on bet detail proves the path for both —
// per the bet's design decision.

test.describe('Rich agent replies — chart + live task checklist', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders inline chart + task checklist at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const parentBet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Bet for rich reply renderer',
				status: 'signal',
			})
			const childTask = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Inline checklist task',
				status: 'todo',
			})

			const chartSpec = JSON.stringify({
				type: 'bar',
				x: 'day',
				series: ['retention'],
				data: [
					{ day: 'Mon', retention: 38 },
					{ day: 'Tue', retention: 42 },
					{ day: 'Wed', retention: 56 },
				],
				caption: 'week-1 retention 38% → 56%',
			})
			const content = ['Progress', '', '```chart', chartSpec, '```', '', 'Status above.'].join('\n')

			await account.api.createComment(account.workspaceId, {
				entity_id: parentBet.id,
				content,
				metadata: { tasks: [childTask.id] },
			})

			await page.goto(`/${account.workspaceId}/objects/${parentBet.id}`)
			await expect(page.getByText('Bet for rich reply renderer')).toBeVisible({ timeout: 10000 })

			// AC-U1: chart caption replaces the fenced code block.
			const caption = page.getByText('week-1 retention 38% → 56%')
			await expect(caption).toBeVisible({ timeout: 10000 })

			// AC-U2: task checklist row links the task title.
			const taskRow = page.getByRole('link', { name: /Inline checklist task/ })
			await expect(taskRow).toBeVisible()

			// AC-U9 / AC-T5: the chart container must not overflow the comment row
			// horizontally at any ship-gate viewport.
			const chartBox = caption.locator('..').first()
			const bbox = await chartBox.boundingBox()
			expect(bbox).not.toBeNull()
			if (bbox) {
				expect(bbox.width).toBeLessThanOrEqual(viewport.width)
			}

			// AC-U4: flipping the referenced task's status updates the checkbox
			// over the existing SSE invalidation channel — no manual reload.
			await account.api.updateObject(childTask.id, account.workspaceId, { status: 'done' })
			const checkbox = page.getByRole('checkbox', { name: /Inline checklist task/ })
			await expect(checkbox).toHaveAttribute('data-state', 'checked', { timeout: 10000 })
		})
	}
})
