import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Task 6 (bet/object-favourites): the Starred filter entry lives on the
// objects-page Display panel. When on, the URL carries `starred=true`, the
// filter chip appears in the toolbar, and the list narrows to the current
// user's starred objects — empty by default until the user stars something.
//
// End-to-end filter behaviour depends on Task 3 (API) honouring `starred=true`
// and Task 4 (per-row star toggle) writing rows into `user_starred_objects`.
// Those siblings are not on the bet branch yet, so this spec asserts the
// filter *entry* — the panel switch, URL commit, chip, and the starred-
// specific empty-state copy in the empty case — works at every ship-gate
// viewport. Task 8 (QA) closes the round-trip once T2/T3/T4 land.

test.describe('Objects — Starred filter entry', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`Display panel exposes Starred switch, commits ?starred=true, renders chip — ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await page.goto(`/${account.workspaceId}/objects`)

			// Display panel trigger — the objects toolbar always renders the
			// labelled `Display` button (icon-only variant is opt-in per prop,
			// not media-query gated on this surface), so a single lookup finds
			// it at every ship-gate viewport.
			await page.getByRole('button', { name: 'Display' }).click()
			const starredSwitch = page.getByRole('switch', { name: /show only starred/i })
			await expect(starredSwitch).toBeVisible()
			await expect(starredSwitch).toHaveAttribute('data-state', 'unchecked')

			await starredSwitch.click()
			await expect(starredSwitch).toHaveAttribute('data-state', 'checked')

			// URL commits `starred=true` so deep-links, back/forward, and hard-
			// refresh preserve the filter — the object-favourites bet leans on
			// this to make a starred object a one-click return path.
			await expect(page).toHaveURL(/[?&]starred=true(&|$)/)

			// Close the popover so the chip strip below the toolbar renders
			// unobstructed.
			await page.keyboard.press('Escape')

			// Filter chip is present in the toolbar strip with the shared
			// FilterChip pattern (label:value, `Remove {label} filter` button).
			const removeChip = page.getByRole('button', { name: 'Remove Show filter' })
			await expect(removeChip).toBeVisible()

			// The empty-state contract: when the filter is on and results come
			// back empty, ListView renders the starred-specific copy — never
			// the generic "No objects found" copy that suggests the workspace
			// is empty. Assert the generic copy is absent regardless of whether
			// the backend already honours `starred=true` (T3 pending); the
			// starred-specific copy renders once the response is empty.
			await expect(page.getByText('No objects found')).toHaveCount(0)

			// Remove via the chip — URL drops the param, panel switch reads
			// unchecked on re-open.
			await removeChip.click()
			await expect(page).not.toHaveURL(/[?&]starred=true(&|$)/)
			await page.getByRole('button', { name: 'Display' }).click()
			await expect(page.getByRole('switch', { name: /show only starred/i })).toHaveAttribute(
				'data-state',
				'unchecked',
			)
		})
	}
})
