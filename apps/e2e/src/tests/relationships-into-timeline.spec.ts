import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers AC-U11 / AC-T6 / AC-T8 — relationships projected into the object's
// activity timeline. The rebuilt object-detail shell keeps the projection (a
// linked object renders as a timeline row at the edge's created_at) and keeps
// SSE invalidation, but retires the legacy Timeline ⇄ Table "Relationship
// view" radio group of AC-U12 / AC-T7: the shell's own Timeline | Related
// segmented control replaces it, and is covered by
// object-detail-properties.spec.ts.

test.describe('Relationships into the timeline (AC-U11)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`projects linked objects and picks up late edges at ${viewport.label}`, async ({
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

			// AC-U11 / AC-T6: the linked insight appears as a timeline row. The
			// Timeline tab is the default, and Radix keeps the Related tab's
			// content unmounted, so this link can only come from the projection.
			await expect(page.getByRole('link', { name: /Inform-relationship insight/ })).toBeVisible({
				timeout: 10000,
			})

			// The legacy Timeline ⇄ Table radio group is gone for good.
			await expect(page.getByRole('group', { name: 'Relationship view' })).toHaveCount(0)

			// AC-T8: a relationship POSTed after the page is open shows up through
			// the existing SSE invalidation channel, with no manual reload.
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
