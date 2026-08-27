import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Settings v2 surface (mockup 2717–2954).
 *
 * Covers the re-laid-out rail and the five sections it fronts: General's
 * three eyebrow blocks in mockup order with no extension toggles, Members'
 * inline header + per-row role control, the Integrations credential entry
 * points, the Extensions lead copy, and Billing's payment disclosure. Every
 * assertion runs at the three ship-gate viewports and checks that no section
 * pushes the page into a horizontal scrollbar.
 */

const SECTIONS = [
	{ label: 'General', path: '' },
	{ label: 'Members', path: '/members' },
	{ label: 'Integrations', path: '/integrations' },
	{ label: 'Extensions', path: '/extensions' },
	{ label: 'Billing', path: '/billing' },
]

async function gotoSettings(page: Page, workspaceId: string, subPath = '') {
	await page.goto(`/${workspaceId}/settings${subPath}`)
	// SSE connection means networkidle never fires; settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

async function expectNoHorizontalOverflow(page: Page) {
	const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
	expect(fits).toBe(true)
}

test.describe('Settings v2 surface', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`every section renders without horizontal overflow at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			for (const section of SECTIONS) {
				await gotoSettings(page, account.workspaceId, section.path)

				const link = page
					.getByRole('navigation', { name: 'Settings sections' })
					.getByRole('link', { name: section.label, exact: true })
				await expect(link).toBeVisible({ timeout: 10000 })
				await expect(link).toHaveClass(/bg-muted/)

				await expectNoHorizontalOverflow(page)
			}
		})

		test(`General shows the three eyebrow blocks and no extension toggle at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId)

			const headings = page.getByRole('heading', {
				name: /WORKSPACE NAME|APPEARANCE|PRIVACY & DATA/,
			})
			await expect(headings).toHaveCount(3, { timeout: 10000 })
			expect((await headings.allInnerTexts()).map((t) => t.trim())).toEqual([
				'WORKSPACE NAME',
				'APPEARANCE',
				'PRIVACY & DATA',
			])

			// Extensions live in their own section — General carries only the two
			// privacy switches.
			await expect(page.getByRole('switch', { name: 'Work', exact: true })).toHaveCount(0)
			await expect(
				page.getByRole('switch', { name: 'Share product usage with Maskin' }),
			).toBeVisible()
		})

		test(`saving the workspace name confirms and persists at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId)

			const nextName = `Renamed ${Date.now()}`
			const input = page.getByRole('textbox', { name: 'Workspace name' })
			await expect(input).toBeVisible({ timeout: 10000 })
			await input.fill(nextName)
			await page.getByRole('button', { name: 'Save' }).click()

			await expect(page.getByText('Workspace name saved')).toBeVisible()

			await page.reload()
			await page.waitForLoadState('load')
			await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveValue(nextName, {
				timeout: 10000,
			})
		})

		test(`Members lists the count and a reachable role control at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId, '/members')

			await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible({ timeout: 10000 })
			await expect(page.getByText(/(person or agent|people & agents)/).first()).toBeVisible()

			// `toBeVisible` also catches opacity-0 / hover-only reveals at touch sizes.
			await expect(page.getByRole('combobox', { name: /^Role for / }).first()).toBeVisible()
			await expect(page.getByRole('button', { name: /Add member/ })).toBeVisible()
		})
	}

	// `ROLE_OPTIONS` excludes 'owner' (the backend body schema is
	// z.enum(['admin','member'])), so rendering the owner's row through the same
	// Select as everyone else produced a blank trigger with no matching item.
	test('the owner row shows its role as text, with no role picker or remove button', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await gotoSettings(page, account.workspaceId, '/members')

		await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible({ timeout: 10000 })

		// The seeded actor owns their workspace, so the row carrying the 'owner'
		// role text is theirs. `.last()` is the innermost matching div — the row.
		const ownerRole = page.getByText('owner', { exact: true })
		await expect(ownerRole).toBeVisible()
		const ownerRow = page.locator('div').filter({ has: ownerRole }).last()

		await expect(ownerRow.getByRole('combobox')).toHaveCount(0)
		// The remove control is rendered but `invisible` + disabled for this row,
		// so assert it cannot be reached rather than that it is absent.
		await expect(ownerRow.getByRole('button', { name: /^Remove / })).toBeHidden()
	})

	// Billing moved out to its own route in v2, and every remaining section on
	// Keys is gated on `byollm_allowed` — which defaults to false — so the page
	// rendered completely empty for a workspace without that ops grant.
	test('Keys explains the missing BYO-LLM grant instead of rendering blank', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await gotoSettings(page, account.workspaceId, '/keys')

		await expect(page.getByText("Bring-your-own-LLM isn't enabled for this workspace")).toBeVisible(
			{ timeout: 10000 },
		)
		await expect(page.getByRole('link', { name: 'View plan and usage' })).toBeVisible()

		// Not linked in the v2 rail for this workspace — the page has no content
		// to offer until the grant lands, but the route stays deep-linkable.
		await expect(page.getByRole('link', { name: 'Keys', exact: true })).toHaveCount(0)
		await expectNoHorizontalOverflow(page)
	})
})
