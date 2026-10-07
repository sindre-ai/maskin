import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// "Install on another organization" — the path for an org that does not have the
// Maskin GitHub App yet.
//
// The picker and "Add existing" only list orgs that already have the App, so
// neither can ever show a brand-new org. Both dialogs therefore carry a button
// that asks POST /api/integrations/github/connect for the App's install page
// (install_new_org) instead of the authorize page.
//
// The pending-selection and linkable lists are route-mocked, and so is connect's
// answer: following the real install_url would leave for github.com. The route
// itself, and the callback that binds the new installation, are covered against
// real Postgres in apps/dev/src/__tests__/integration/github-install-another-org.test.ts.

const PENDING_ID = '00000000-0000-4000-8000-0000000000bb'

async function mockPendingSelection(page: Page) {
	await page.route('**/api/integrations/github/pending-selection/*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				integrationId: PENDING_ID,
				installations: [
					{ installationId: '146523409', ownerLogin: 'sindre-ai' },
					{ installationId: '154364583', ownerLogin: 'other-org' },
				],
			}),
		})
	})
}

async function mockLinkable(page: Page) {
	await page.route('**/api/integrations/github/linkable', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{ installationId: '4242', ownerLogin: 'acme-org', alreadyLinked: false },
			]),
		})
	})
}

/** Answer connect with a same-origin URL so the click's redirect stays in the app. */
async function mockConnect(page: Page, workspaceId: string) {
	const bodies: unknown[] = []
	await page.route('**/api/integrations/github/connect', async (route) => {
		bodies.push(route.request().postDataJSON())
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				install_url: `/${workspaceId}/settings/integrations?install_stub=1`,
			}),
		})
	})
	return bodies
}

async function goto(page: Page, path: string) {
	await page.goto(path)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — Integrations — install the GitHub App on another org', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the picker offers the install action at ${viewport.label}`, async ({ page, account }) => {
			await mockPendingSelection(page)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await goto(page, `/${account.workspaceId}/settings/integrations?select_github=${PENDING_ID}`)

			await expect(
				page.getByRole('heading', { name: 'Choose a GitHub organization' }),
			).toBeVisible()

			// toBeVisible() checks opacity + visibility, so a hover-only reveal
			// (unreachable on touch) fails here rather than passing silently.
			await expect(
				page.getByRole('button', { name: 'Install on another organization' }),
			).toBeVisible()
		})
	}

	test('"Add existing" offers the install action too', async ({ page, account }) => {
		await mockLinkable(page)
		await goto(page, `/${account.workspaceId}/settings/integrations`)

		await page.getByRole('button', { name: 'Add existing' }).click()
		await expect(
			page.getByRole('heading', { name: 'Add an existing GitHub organization' }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Install on another organization' }),
		).toBeVisible()
	})

	test('asks connect for the App install page, not the authorize page', async ({
		page,
		account,
	}) => {
		await mockPendingSelection(page)
		const bodies = await mockConnect(page, account.workspaceId)
		await goto(page, `/${account.workspaceId}/settings/integrations?select_github=${PENDING_ID}`)

		await page.getByRole('button', { name: 'Install on another organization' }).click()

		await expect(page).toHaveURL(/install_stub=1/)
		expect(bodies).toEqual([{ install_new_org: true }])
	})

	test('the picker action renders in both colour schemes', async ({ page, account }) => {
		await mockPendingSelection(page)
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await goto(page, `/${account.workspaceId}/settings/integrations?select_github=${PENDING_ID}`)
			await expect(
				page.getByRole('button', { name: 'Install on another organization' }),
			).toBeVisible()
		}
	})
})
