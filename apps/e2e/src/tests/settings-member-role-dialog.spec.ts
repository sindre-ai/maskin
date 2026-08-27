import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings → Members: changing a human teammate's role from HumanDetailDialog.
 *
 * The members list is route-mocked. A fixture workspace is on the trial plan,
 * whose seat cap is one human (SEAT_CAPS in packages/shared/src/billing-caps.ts),
 * so POST /members refuses to add a second human and no test account can hold
 * one. The cap itself is covered against real Postgres in
 * apps/dev/src/__tests__/integration/. What is asserted here is the UI path the
 * mock can't fake: the row opens the dialog, the dialog's role Select is
 * reachable at touch sizes, and picking a role issues the PATCH.
 */

const TEAMMATE = {
	actorId: '00000000-0000-4000-8000-0000000000aa',
	name: 'Mocked Teammate',
	type: 'human',
	joinedAt: new Date(0).toISOString(),
}

async function mockMembers(page: Page, workspaceId: string) {
	// Role is served from a closure so the PATCH below can flip it, which is
	// what the page refetches after a successful mutation.
	let teammateRole = 'member'

	await page.route('**/api/workspaces/*/members', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const res = await route.fetch()
		const existing = (await res.json()) as Array<Record<string, unknown>>
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([...existing, { ...TEAMMATE, role: teammateRole }]),
		})
	})

	const patched: string[] = []
	await page.route(
		`**/api/workspaces/${workspaceId}/members/${TEAMMATE.actorId}`,
		async (route) => {
			const body = route.request().postDataJSON() as { role?: string } | null
			teammateRole = body?.role ?? teammateRole
			patched.push(teammateRole)
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ...TEAMMATE, role: teammateRole }),
			})
		},
	)

	return patched
}

test.describe('Settings — HumanDetailDialog role change', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`admin can change a human member's role from the dialog at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const patched = await mockMembers(page, account.workspaceId)

			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/members`)
			await page.waitForLoadState('load')

			// Rows are buttons, not table rows — the list is a flex column of
			// clickable member cards.
			const teammateRow = page.getByRole('button', { name: TEAMMATE.name })
			await expect(teammateRow).toBeVisible({ timeout: 10000 })

			await teammateRow.click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()

			const roleSelect = dialog.getByRole('combobox', {
				name: new RegExp(`Role for ${TEAMMATE.name}`),
			})
			// `toBeVisible` also catches opacity-0 / hover-only reveals at touch sizes.
			await expect(roleSelect).toBeVisible()
			await expect(roleSelect).toHaveText(/member/)

			await roleSelect.click()
			await page.getByRole('option', { name: 'admin' }).click()

			await expect(roleSelect).toHaveText(/admin/, { timeout: 10000 })
			expect(patched).toEqual(['admin'])
		})
	}
})
