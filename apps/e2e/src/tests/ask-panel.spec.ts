import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// The Ask panel (bet T5) is reached from the bulk-action bar for the current
// selection and shows per-ask rows backed by `needs_input` notifications.
// Approve/Hold round-trip through POST /api/notifications/:id/respond and the
// row flips to a done label. The panel opens as a bottom sheet on mobile
// (ResponsiveDialog ≤768px) and a dialog on desktop, so the reachability and
// interaction are asserted at every ship-gate viewport.

async function seedAsk(account: { api: TestAPI; workspaceId: string }) {
	const obj = await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Ask Target Bet',
		status: 'signal',
	})
	const agent = await account.api.createAgentActor('Asking Agent')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id, 'member')
	await account.api.createNotification(account.workspaceId, {
		type: 'needs_input',
		title: 'Approve the launch',
		content: 'Can you approve releasing this to users?',
		source_actor_id: agent.id,
		object_id: obj.id,
	})
	return obj
}

test.describe('Ask panel — bulk-bar round-trip (ship gate)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`approving an ask shows a done label @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await seedAsk(account)

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Ask Target Bet')).toBeVisible({ timeout: 10000 })

			const checkbox = page.getByRole('checkbox', { name: 'Select row' }).first()
			await expect(checkbox).toBeVisible()
			await checkbox.click()
			await expect(page.getByLabel('1 selected')).toBeVisible()

			// The bulk bar reveals the reachable trigger once the selected row has an ask.
			const answerBtn = page.getByRole('button', { name: 'Answer 1 ask' })
			await expect(answerBtn).toBeVisible()
			await answerBtn.click()

			// Scoped to the panel: the row behind it also renders an "<Agent> asks
			// · <text>" line, which would otherwise ambiguously match these texts.
			const panel = page.getByRole('dialog')
			await expect(panel.getByText('Asking Agent', { exact: true })).toBeVisible()
			await expect(panel.getByText('Can you approve releasing this to users?')).toBeVisible()

			// Approve round-trips: the row flips to a done label and the footer
			// reports nothing left waiting.
			await panel.getByRole('button', { name: 'Approve' }).click()
			await expect(panel.getByText('Approved')).toBeVisible()
			await expect(panel.getByText('Nothing left waiting here')).toBeVisible()
		})
	}
})

test.describe('Ask panel — light and dark mode', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`approve controls are visible @ ${scheme}`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await page.setViewportSize({
				width: VIEWPORTS.tabletLandscape.width,
				height: VIEWPORTS.tabletLandscape.height,
			})
			await seedAsk(account)

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Ask Target Bet')).toBeVisible({ timeout: 10000 })

			await page.getByRole('checkbox', { name: 'Select row' }).first().click()
			await page.getByRole('button', { name: 'Answer 1 ask' }).click()

			// The primary Approve button and the shared avatar must be visible in
			// both modes (they use theme tokens, not hardcoded hex). Scoped to the
			// panel — the row behind it also renders an "<Agent> asks · <text>" line.
			const panel = page.getByRole('dialog')
			await expect(panel.getByRole('button', { name: 'Approve' })).toBeVisible()
			await expect(panel.getByText('Asking Agent', { exact: true })).toBeVisible()
		})
	}
})
