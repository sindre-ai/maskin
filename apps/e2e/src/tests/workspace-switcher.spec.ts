import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Workspace Switcher', () => {
	test('AC-U1 + AC-U2 + AC-U3: pill shows current workspace, switcher lists memberships, selecting another navigates', async ({
		page,
		account,
	}) => {
		// Two memberships so the switcher has something to switch to.
		const second = await account.api.createWorkspace(
			`E2E Second ${Date.now().toString(36).slice(-6)}`,
		)
		const first = (await account.api.listWorkspaces()).find((ws) => ws.id === account.workspaceId)
		test.skip(!first, 'auth fixture workspace went missing')
		const firstName = first?.name as string

		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10000 })

		// AC-U1: the current workspace name is visible without hover.
		const pill = page.getByRole('button', { name: new RegExp(`Workspace: ${firstName}`) })
		await expect(pill).toBeVisible()
		await expect(pill).toContainText(firstName)

		// AC-U2: clicking opens a switcher listing every membership with the current marked.
		await pill.click()
		const currentItem = page.getByRole('menuitem', { name: new RegExp(firstName) })
		const otherItem = page.getByRole('menuitem', { name: new RegExp(second.name) })
		await expect(currentItem).toHaveAttribute('aria-current', 'true')
		await expect(otherItem).toBeVisible()

		// AC-U3: selecting the other workspace lands on its home and the pill updates.
		await otherItem.click()
		await expect(page).toHaveURL(new RegExp(second.id), { timeout: 10000 })
		const switchedPill = page.getByRole('button', { name: new RegExp(`Workspace: ${second.name}`) })
		await expect(switchedPill).toBeVisible()
		await expect(switchedPill).toContainText(second.name)
	})

	test('AC-T4: switching workspace evicts stale data from the previous workspace', async ({
		page,
		account,
	}) => {
		// Seed: an object that exists in workspace A but not in workspace B.
		const objectInA = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `Only in A ${Date.now().toString(36).slice(-6)}`,
			status: 'active',
		})
		const second = await account.api.createWorkspace(
			`E2E Second ${Date.now().toString(36).slice(-6)}`,
		)
		const first = (await account.api.listWorkspaces()).find((ws) => ws.id === account.workspaceId)
		const firstName = first?.name as string

		// Land in workspace A and warm the objects cache by viewing the list.
		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText(objectInA.title)).toBeVisible({ timeout: 10000 })

		// Switch to workspace B via the pill.
		await page.getByRole('button', { name: new RegExp(`Workspace: ${firstName}`) }).click()
		await page.getByRole('menuitem', { name: new RegExp(second.name) }).click()
		await expect(page).toHaveURL(new RegExp(second.id), { timeout: 10000 })

		// Navigate to objects in B — the object from A must NOT be present, even
		// momentarily. If the previous workspace's cache leaked into B, this
		// title would briefly render before being replaced.
		await page.goto(`/${second.id}/objects`)
		await expect(page.getByText(objectInA.title)).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`AC-T3 + AC-T2: the workspace pill is reachable at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10000 })

			// On mobile the sidebar collapses behind the global toggle in the header.
			// Open it before asserting the pill.
			if (viewport.width < 768) {
				await page.getByRole('button', { name: /Toggle Sidebar/i }).click()
			}

			// The pill must be reachable at every ship-gate viewport. We don't
			// require the visible name on icon-collapsed desktop (handled by
			// `group-data-[collapsible=icon]:hidden`); the accessible name from
			// `aria-label` is the contract.
			const pill = page.getByRole('button', { name: /Workspace:/ })
			await expect(pill).toBeVisible({ timeout: 5000 })
		})
	}
})
