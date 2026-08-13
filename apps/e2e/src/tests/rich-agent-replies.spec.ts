import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers the shared agent-reply renderer: inline chart + live task checklist.
// Both surfaces (For You unread cards and bet detail) render through
// ActivityComment. The rebuilt object-detail shell (bet/object-detail, T1)
// does not render the activity timeline yet (T2 scope), so the rich-reply
// surface is pinned absent on the detail page here; the renderer itself is
// still covered component-level. When the activity tab lands, this spec
// re-scopes to the chart-caption / checklist ACs on the real thread.

test.describe('Rich agent replies — T1 absence contract on the detail surface', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`no chart or checklist surfaces on the T1 shell at ${viewport.label}`, async ({
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

			// The rich comment exists server-side, but the T1 shell has no
			// timeline to render it in.
			await account.api.createComment(account.workspaceId, {
				entity_id: parentBet.id,
				content,
				metadata: { tasks: [childTask.id] },
			})

			await page.goto(`/${account.workspaceId}/objects/${parentBet.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Bet for rich reply renderer' }),
			).toBeVisible({ timeout: 10000 })

			// No chart caption, no task checklist link, no checklist checkbox.
			await expect(page.getByText('week-1 retention 38% → 56%')).toHaveCount(0)
			await expect(page.getByRole('link', { name: /Inline checklist task/ })).toHaveCount(0)
			await expect(page.getByRole('checkbox', { name: /Inline checklist task/ })).toHaveCount(0)
		})
	}
})
