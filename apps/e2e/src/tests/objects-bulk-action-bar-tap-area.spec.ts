import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// OL2: on coarse (touch) pointers each named action button in the
// BulkActionBar must report ≥44×44 CSS pixels. WCAG 2.5.5 Target Size +
// Maskin 44px rule. Desktop (fine pointer) rendering must be unchanged.

// Labels are singular here because the test selects exactly one row (see
// openBulkBar). The BulkActionBar pluralises when selectedCount > 1.
const NAMED_BUTTONS = [
	'Copy link',
	'Copy title',
	'Copy title as link',
	'Open in new tab',
	'Delete selected',
	'Clear selection',
] as const

async function openBulkBar(
	page: Page,
	account: {
		api: { createObject: (wsId: string, body: Record<string, unknown>) => Promise<{ id: string }> }
		workspaceId: string
	},
) {
	await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'BulkBar Tap Test A',
		status: 'signal',
	})
	await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'BulkBar Tap Test B',
		status: 'signal',
	})

	await page.goto(`/${account.workspaceId}/objects`)
	await expect(page.getByText('BulkBar Tap Test A')).toBeVisible({ timeout: 10000 })

	const firstCheckbox = page.getByRole('checkbox', { name: 'Select row' }).first()
	await expect(firstCheckbox).toBeVisible()
	await firstCheckbox.click()

	const bulkBar = page.locator('[aria-label="Bulk actions"]')
	await expect(bulkBar).toHaveAttribute('aria-hidden', 'false')
	return bulkBar
}

async function assertMin44(button: Locator, label: string, viewportLabel: string) {
	await expect(button, `${label} visible @ ${viewportLabel}`).toBeVisible()
	const box = await button.boundingBox()
	if (!box) throw new Error(`boundingBox missing for ${label} @ ${viewportLabel}`)
	expect(box.width, `${label} width ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
	expect(box.height, `${label} height ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
}

test.describe('BulkActionBar tap targets — coarse pointer (touch)', () => {
	// hasTouch: true tells Chromium to report `pointer: coarse`, which is what
	// the CSS variant is gated on. Fine-pointer runs use the default context.
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`all named action buttons are ≥44×44 CSS px @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const bulkBar = await openBulkBar(page, account)

			for (const name of NAMED_BUTTONS) {
				const button = bulkBar.getByRole('button', { name })
				await assertMin44(button, name, viewport.label)
			}
		})
	}
})

test.describe('BulkActionBar tap targets — fine pointer (desktop)', () => {
	test('icon action buttons stay at ~32px on desktop (fine-pointer rendering unchanged)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		const bulkBar = await openBulkBar(page, account)

		// Copy link is a size-8 icon button on desktop — the pointer-coarse
		// bump must NOT apply, so it stays below 44px.
		const copyLink = bulkBar.getByRole('button', { name: 'Copy link' })
		await expect(copyLink).toBeVisible()
		const box = await copyLink.boundingBox()
		if (!box) throw new Error('Copy link boundingBox missing on desktop')
		expect(box.width).toBeLessThan(44)
		expect(box.height).toBeLessThan(44)
	})
})
