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

				// Scoped by the rail's accessible name: a sub-page also renders the
				// detail bar's crumb nav, which comes first in the DOM, so an
				// unscoped `.first()` resolves into the wrong landmark.
				const nav = page.getByRole('navigation', { name: 'Settings sections' })
				const link = nav.getByRole('link', { name: section.label, exact: true })
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

		test(`Integrations exposes the model-provider and MCP entry points at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId, '/integrations')

			await expect(
				page.getByText('Connect the tools your agents read from and write to').first(),
			).toBeVisible({ timeout: 10000 })

			const modelProviders = page.getByRole('link', { name: /Model providers/ })
			await expect(modelProviders).toBeVisible()
			await modelProviders.click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings/keys$`))

			await gotoSettings(page, account.workspaceId, '/integrations')
			const mcpLink = page.getByRole('link', { name: /Connect your coding agent/ })
			await expect(mcpLink).toBeVisible()
			await mcpLink.click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings/mcp$`))
		})

		test(`Billing's payment disclosure opens and closes at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId, '/billing')

			const trigger = page.getByRole('button', { name: /Payment, details and invoices/ })
			await expect(trigger).toBeVisible({ timeout: 10000 })
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toHaveCount(0)

			await trigger.click()
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toBeVisible()
			// A seeded workspace has never paid, so there is no Stripe Customer and
			// no card — this is the card-absent copy. The card-present string was
			// asserted here before and exists nowhere in the app, so the assertion
			// could never pass.
			await expect(page.getByText(/No card on file\. Stripe handles the payment/)).toBeVisible()

			await trigger.click()
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toHaveCount(0)
		})
	}

	// The billing statuses were missing from `statusColors`, so `StatusBadge`
	// fell through to a hardcoded zinc-700 pill that is low-contrast on white.
	test('the plan status pill uses its status tokens in both light and dark mode', async ({
		page,
		account,
	}) => {
		for (const theme of ['light', 'dark'] as const) {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
			await page.setViewportSize(VIEWPORTS.mobile)
			await gotoSettings(page, account.workspaceId, '/billing')

			if (theme === 'dark') {
				const isDark = await page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				)
				expect(isDark).toBe(true)
			}

			const badge = page.getByText('inactive', { exact: true }).first()
			await expect(badge).toBeVisible({ timeout: 10000 })
			await expect(badge).not.toHaveClass(/bg-zinc-700/)
			await expect(badge).toHaveClass(/bg-status-parked-bg/)
		}
	})
})

/**
 * General's two typographic decisions (mockup 2697–2709).
 *
 * The section labels are the 11px sans caps, not the 8px mono `.eyebrow` used
 * for the app's other micro-labels; and the selected Appearance option is the
 * solid near-black pill. Both are colour/size choices no structural assertion
 * catches — `--secondary` (#f6f6f7) on a white card renders as no selection at
 * all in light mode, which is exactly the failure mode this covers.
 */
test.describe('Settings > General — labels and Appearance', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`section labels use the 11px sans style at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId)

			for (const name of ['WORKSPACE NAME', 'APPEARANCE', 'PRIVACY & DATA']) {
				const label = page.getByRole('heading', { name })
				await expect(label).toBeVisible({ timeout: 10000 })
				const style = await label.evaluate((el) => {
					const cs = getComputedStyle(el)
					return { fontSize: cs.fontSize, fontFamily: cs.fontFamily, weight: cs.fontWeight }
				})
				expect(style.fontSize).toBe('11px')
				expect(style.fontFamily).not.toMatch(/mono/i)
				expect(Number(style.weight)).toBeGreaterThanOrEqual(600)
			}
		})

		test(`the selected Appearance option is a filled pill at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			for (const theme of ['light', 'dark'] as const) {
				await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
				await gotoSettings(page, account.workspaceId)

				const selected = page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark' })
				await expect(selected).toBeVisible({ timeout: 10000 })

				// The pill's fill must be the near-black (light) / near-white (dark)
				// --primary, and its label the paired foreground — never the
				// near-white --secondary, which is invisible on the white card.
				const fill = await selected.evaluate((el) => {
					const cs = getComputedStyle(el)
					return { bg: cs.backgroundColor, fg: cs.color }
				})
				expect(fill.bg).toBe(theme === 'light' ? 'rgb(24, 24, 27)' : 'rgb(250, 250, 250)')
				expect(fill.fg).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 27)')

				// The other two stay unfilled.
				const unselected = page.getByRole('button', { name: 'System' })
				const unselectedBg = await unselected.evaluate((el) => getComputedStyle(el).backgroundColor)
				expect(unselectedBg).toBe('rgba(0, 0, 0, 0)')
			}
		})
	}
})

/**
 * Billing's plan strip and plan grid (mockup 2851–2900).
 *
 * The catalogue is marketing copy, so what is worth asserting is the shape of
 * the surface and the rule that keeps it honest: on an instance with no Stripe
 * configured nothing is purchasable, so no card may offer a checkout.
 */
test.describe('Settings > Billing — plan strip and plans', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the strip shows plan, usage and reset stats at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId, '/billing')

			for (const label of ['PLAN', 'USED THIS MONTH', 'RESETS']) {
				await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 10000 })
			}
			// No meter is drawn — there is no included-usage denominator to fill it.
			await expect(page.locator('[role="progressbar"]')).toHaveCount(0)
			await expectNoHorizontalOverflow(page)
		})

		test(`the four tiers render and collapse at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId, '/billing')

			for (const tier of ['TRIAL', 'PRO', 'TEAM', 'ENTERPRISE']) {
				await expect(page.getByText(tier, { exact: true })).toBeVisible({ timeout: 10000 })
			}
			await expect(page.getByText('MOST POPULAR')).toBeVisible()

			// The CTAs must be reachable on touch, not hover-revealed.
			const ctas = page.getByRole('button', { name: /Contact sales|Choose |Current plan/ })
			await expect(ctas.first()).toBeVisible()

			const toggle = page.getByRole('button', { name: 'Hide plans' })
			await toggle.click()
			await expect(page.getByText('TRIAL', { exact: true })).toHaveCount(0)
			await page.getByRole('button', { name: 'Show plans' }).click()
			await expect(page.getByText('TRIAL', { exact: true })).toBeVisible()

			await expectNoHorizontalOverflow(page)
		})
	}

	// Nothing can be sold without Stripe, so nothing may claim to sell.
	test('offers no checkout CTA while Stripe is unconfigured', async ({ page, account }) => {
		await gotoSettings(page, account.workspaceId, '/billing')

		await expect(page.getByText('ENTERPRISE', { exact: true })).toBeVisible({ timeout: 10000 })
		await expect(page.getByRole('button', { name: /^Choose (Trial|Pro|Team)$/ })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Choose a plan' })).toBeDisabled()
	})

	// The featured card's border and badge are tokens, so they must survive the
	// theme flip rather than washing out on one side of it.
	test('the featured card stays legible in light and dark mode', async ({ page, account }) => {
		for (const theme of ['light', 'dark'] as const) {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
			await gotoSettings(page, account.workspaceId, '/billing')

			const badge = page.getByText('MOST POPULAR')
			await expect(badge).toBeVisible({ timeout: 10000 })
			const colors = await badge.evaluate((el) => {
				const cs = getComputedStyle(el)
				return { bg: cs.backgroundColor, fg: cs.color }
			})
			// bg-foreground / text-background — inverted, and inverted the other way
			// round in dark mode.
			expect(colors.bg).toBe(theme === 'light' ? 'rgb(24, 24, 27)' : 'rgb(250, 250, 250)')
			expect(colors.fg).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(9, 9, 11)')
		}
	})
})
