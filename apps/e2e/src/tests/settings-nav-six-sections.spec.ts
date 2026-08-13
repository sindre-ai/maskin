import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings left-rail six-section re-group (T5).
 *
 * Verifies the Settings rail exposes exactly the six mockup sections in the
 * approved order — General, Objects, Members, Integrations, Extensions,
 * Billing — that each section is deep-linkable via
 * /$workspaceId/settings/<section>, and that the rail retains its mobile
 * horizontal chip strip at 375px. Legacy Skills / LLM / MCP labels must no
 * longer appear in the rail.
 */

const SIX_SECTIONS = ['General', 'Objects', 'Members', 'Integrations', 'Extensions', 'Billing']
const RETIRED_LABELS = ['Skills', 'LLM', 'MCP']

const DEEP_LINKS: Array<{ label: string; path: string }> = [
	{ label: 'General', path: '' },
	{ label: 'Objects', path: '/objects' },
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

test.describe('Settings — six-section left rail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`rail lists the six mockup sections in order at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSettings(page, account.workspaceId)

			const nav = page.getByRole('navigation').first()
			await expect(nav).toBeVisible({ timeout: 10000 })

			const labels = await nav.getByRole('link').allInnerTexts()
			expect(labels.map((t) => t.trim())).toEqual(SIX_SECTIONS)

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

			const nav = page.getByRole('navigation').first()
			const link = nav.getByRole('link', { name: label, exact: true })
			await expect(link).toBeVisible({ timeout: 10000 })
			// Active item styles carry `bg-muted` + `font-medium` — a proxy for the
			// SettingsLayout's matchRoute-driven active state.
			await expect(link).toHaveClass(/bg-muted/)
			await expect(link).toHaveClass(/font-medium/)
		})
	}
})
