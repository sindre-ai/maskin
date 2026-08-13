import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers AC-U11 / AC-U12 / AC-T6 / AC-T7 / AC-T8 — the relationships-into-the-timeline
// surface. The rebuilt object-detail shell (bet/object-detail, T1) does not yet
// render the activity/timeline projections (T2–T4 scope), so this spec pins the
// surface absent on the T1 shell: the linked object must not appear as a
// timeline row and no Relationship-view toggle may render. When the timeline
// tab lands this spec re-scopes to the original ACs (edge created_at ordering,
// Timeline ↔ Table persistence, SSE invalidation).

test.describe('Relationships into the timeline (AC-U11/U12) — T1 absence contract', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`no timeline projection or view toggle on the T1 shell at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Relationships timeline bet',
				status: 'signal',
			})
			const informingInsight = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Inform-relationship insight',
				status: 'new',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'insight',
				source_id: informingInsight.id,
				target_type: 'bet',
				target_id: bet.id,
				type: 'informs',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Relationships timeline bet' }),
			).toBeVisible({ timeout: 10000 })

			// No Timeline/Table toggle, no inline timeline row, no edge-type table.
			await expect(page.getByRole('group', { name: 'Relationship view' })).toHaveCount(0)
			await expect(page.getByRole('link', { name: /Inform-relationship insight/ })).toHaveCount(0)
			await expect(page.getByText(/informs/i)).toHaveCount(0)
		})
	}
})
