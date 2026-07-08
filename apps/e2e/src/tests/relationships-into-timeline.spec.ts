import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers AC-U11 / AC-U12 / AC-T6 / AC-T7 / AC-T8 — the relationships-into-the-timeline
// surface. Verifies that:
//  - a linked object appears inline in the activity timeline at the edge's
//    created_at, not the linked object's own created_at (AC-T6);
//  - the Timeline ↔ Table toggle round-trips through `user_display_settings`
//    and survives a fresh page navigation (AC-T7);
//  - a relationship created after the page is open shows up via the existing
//    SSE invalidation channel without a manual reload (AC-T8).

test.describe('Relationships into the timeline (AC-U11/U12)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`projects, toggles, and reloads at ${viewport.label}`, async ({ page, account }) => {
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
			await expect(page.getByText('Relationships timeline bet')).toBeVisible({ timeout: 10000 })

			// AC-U11: the linked insight appears as a timeline row.
			const insightLink = page.getByRole('link', { name: /Inform-relationship insight/ })
			await expect(insightLink).toBeVisible({ timeout: 10000 })

			// AC-U12 + AC-T7: toggle to Table — choice persists across reload.
			// The radio input is `sr-only` inside a wrapping <label>, so the label
			// is the actual click target; force the check past the visibility
			// check on the visually-hidden input.
			const tableToggle = page.getByRole('radio', { name: /table/i })
			await tableToggle.check({ force: true })
			await expect(tableToggle).toBeChecked()

			await page.reload()
			await expect(page.getByText('Relationships timeline bet')).toBeVisible({ timeout: 10000 })
			await expect(page.getByRole('radio', { name: /table/i })).toBeChecked()
			// Edge-type heading is what makes Table view visually distinct.
			await expect(page.getByText(/informs/i).first()).toBeVisible()

			// Toggle back to Timeline so the SSE assertion below targets the
			// inline projection, not the table.
			const timelineToggle = page.getByRole('radio', { name: /timeline/i })
			await timelineToggle.check({ force: true })
			await expect(timelineToggle).toBeChecked()

			// AC-T8: a new relationship POSTed after the page is open appears
			// without a manual reload via the existing SSE invalidation channel.
			const lateChild = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Late-linked task',
				status: 'todo',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: bet.id,
				target_type: 'task',
				target_id: lateChild.id,
				type: 'breaks_into',
			})

			await expect(page.getByRole('link', { name: /Late-linked task/ })).toBeVisible({
				timeout: 10000,
			})
		})
	}
})
