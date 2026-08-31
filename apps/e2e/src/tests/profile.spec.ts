import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openSidebarOnMobile } from '../helpers/sidebar.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Your profile — v2's `Profile` screen, reached from the sidebar's profile menu.
//
// The page is backed by the actor record: the name and email rows write through
// PATCH /api/actors/:id, and "How to work with me" writes the actor description,
// which is the field agents actually receive. Every assertion here is about that
// round-trip surviving a reload, not about local component state.

// The fixture seeds a per-test actor name, so the spec reads it back from the
// auth blob it injects rather than hardcoding one.
async function signedInName(page: Page): Promise<string> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('maskin-actor')
		return raw ? (JSON.parse(raw).name as string) : ''
	})
}

test.describe('Profile', () => {
	test('opens from the sidebar profile menu', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		const name = await signedInName(page)
		await page
			.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]')
			.getByRole('button', { name: new RegExp(name.slice(0, 20), 'i') })
			.click()
		await page.getByRole('menuitem', { name: 'Your profile' }).click()

		await expect(page).toHaveURL(/\/profile$/, { timeout: 10_000 })
		await expect(page.getByRole('heading', { name })).toBeVisible()
	})

	test('saves "How to work with me" onto the actor so agents can read it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)

		await page.getByRole('button', { name: 'Edit' }).click()
		const box = page.getByRole('textbox', { name: 'How to work with me' })
		await box.fill('Ask before emailing anyone outside the company.')
		await page.getByRole('button', { name: 'Done' }).click()

		await expect(page.getByText('Ask before emailing anyone outside the company.')).toBeVisible()

		// It survives a reload because it landed on the actor record, not in state.
		await page.reload()
		await expect(page.getByText('Ask before emailing anyone outside the company.')).toBeVisible({
			timeout: 10_000,
		})
	})

	test('renames the account in place and keeps the new name after a reload', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)

		const renamed = `Renamed ${Date.now()}`
		await page.getByRole('button', { name: /Edit full name/ }).click()
		await page.getByRole('textbox', { name: 'Full name' }).fill(renamed)
		await page.keyboard.press('Enter')

		await expect(page.getByRole('heading', { name: renamed })).toBeVisible({ timeout: 10_000 })
		await page.reload()
		await expect(page.getByRole('heading', { name: renamed })).toBeVisible({ timeout: 10_000 })
	})

	test('leaves the name alone when an edit is abandoned with Escape', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)
		const name = await signedInName(page)

		await page.getByRole('button', { name: /Edit full name/ }).click()
		await page.getByRole('textbox', { name: 'Full name' }).fill('Discarded')
		await page.keyboard.press('Escape')

		await expect(page.getByRole('heading', { name })).toBeVisible()
		await page.reload()
		await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 })
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`reads and stays in one column at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/profile`)
			if (viewport.width < 768) await openSidebarOnMobile(page)

			const name = await signedInName(page)
			await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('How to work with me')).toBeVisible()
			await expect(page.getByText('Account', { exact: true })).toBeVisible()

			// The page itself must never scroll sideways at any ship-gate width.
			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			)
			expect(overflows).toBe(false)
		})
	}

	test('renders in both colour schemes', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)
		const name = await signedInName(page)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('How to work with me')).toBeVisible()
		}
	})
})
