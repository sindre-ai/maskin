import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings left-rail sections.
 *
 * Verifies the Settings rail exposes the approved sections in order —
 * General, Objects, Members, Integrations, Extensions, Skills, MCP, Billing —
 * that each section is deep-linkable via /$workspaceId/settings/<section>, and
 * that the rail retains its mobile horizontal chip strip at 375px.
 *
 * Skills and MCP were both re-added after the T5 six-section re-group removed
 * them; both routes are agent-facing configuration surfaces that operators need
 * discoverable from the settings sidebar. The retired-label guard now only
 * covers LLM (which lives under the enterprise-only Keys route).
 */

const SETTINGS_SECTIONS = [
	'General',
	'Objects',
	'Members',
	'Integrations',
	'Extensions',
	'Skills',
	'MCP',
	'Billing',
]
const RETIRED_LABELS = ['LLM']

const DEEP_LINKS: Array<{ label: string; path: string }> = [
	{ label: 'General', path: '' },
	{ label: 'Objects', path: '/objects' },
	{ label: 'Members', path: '/members' },
	{ label: 'Integrations', path: '/integrations' },
	{ label: 'Extensions', path: '/extensions' },
	{ label: 'Skills', path: '/skills' },
	{ label: 'MCP', path: '/mcp' },
	{ label: 'Billing', path: '/billing' },
]

async function gotoSettings(page: Page, workspaceId: string, subPath = '') {
	await page.goto(`/${workspaceId}/settings${subPath}`)
	// SSE connection means networkidle never fires; settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — left rail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`rail lists the settings sections in order at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId)

			const nav = page.getByRole('navigation', { name: 'Settings sections' })
			await expect(nav).toBeVisible({ timeout: 10000 })

			const labels = await nav.getByRole('link').allInnerTexts()
			expect(labels.map((t) => t.trim())).toEqual(SETTINGS_SECTIONS)

			for (const retired of RETIRED_LABELS) {
				await expect(nav.getByRole('link', { name: retired, exact: true })).toHaveCount(0)
			}
		})
	}

	for (const { label, path } of DEEP_LINKS) {
		test(`deep link /settings${path} resolves and marks ${label} active`, async ({
			page,
			account,
		}) => {
			await gotoSettings(page, account.workspaceId, path)

			const nav = page.getByRole('navigation', { name: 'Settings sections' })
			const link = nav.getByRole('link', { name: label, exact: true })
			await expect(link).toBeVisible({ timeout: 10000 })
			// Active item styles carry `bg-muted` + `font-bold` (mockup 2721 puts the
			// active rail item at weight 700) — a proxy for the SettingsLayout's
			// matchRoute-driven active state.
			await expect(link).toHaveClass(/bg-muted/)
			await expect(link).toHaveClass(/font-bold/)
		})
	}
})
