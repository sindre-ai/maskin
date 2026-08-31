import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// "Add existing" — the path for adding a GitHub org to a second workspace.
// GitHub installs its App once per org, so a workspace that wants an org
// someone already connected can't run the install flow; it binds the existing
// installation via POST /api/integrations/github/link instead.
//
// The linkable list is route-mocked: producing a real entry would need a second
// workspace holding a genuine GitHub App installation, which no test account
// can have. The bind call itself is covered against real Postgres in
// apps/dev/src/__tests__/integration/github-multi-workspace-link.test.ts.

const LINKABLE = [
	{ installationId: '4242', ownerLogin: 'acme-org', alreadyLinked: false },
	{ installationId: '99', ownerLogin: 'already-here-org', alreadyLinked: true },
]

async function mockLinkable(page: Page) {
	await page.route('**/api/integrations/github/linkable', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(LINKABLE),
		})
	})
}

async function gotoIntegrations(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/integrations`)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — Integrations — add an existing GitHub org', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`"Add existing" is reachable and lists bindable orgs at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mockLinkable(page)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoIntegrations(page, account.workspaceId)

			// toBeVisible() checks opacity + visibility, so a hover-only reveal
			// (unreachable on touch) fails here rather than passing silently.
			const addExisting = page.getByRole('button', { name: 'Add existing' })
			await expect(addExisting).toBeVisible()

			await addExisting.click()

			await expect(
				page.getByRole('heading', { name: 'Add an existing GitHub organization' }),
			).toBeVisible()

			// Only the unlinked org is offered; one already in this workspace is not.
			await expect(page.getByText('acme-org')).toBeVisible()
			await expect(page.getByText('already-here-org')).toHaveCount(0)

			// The action that does the binding must itself be reachable on touch.
			await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
		})
	}

	test('binds the installation and reports success', async ({ page, account }) => {
		await mockLinkable(page)
		let linkBody: unknown = null
		await page.route('**/api/integrations/github/link', async (route) => {
			linkBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					id: '00000000-0000-4000-8000-000000000001',
					workspaceId: account.workspaceId,
					provider: 'github',
					status: 'active',
					externalId: '4242',
					config: { owner_login: 'acme-org' },
					createdBy: account.actorId,
					createdAt: null,
					updatedAt: null,
				}),
			})
		})

		await gotoIntegrations(page, account.workspaceId)
		await page.getByRole('button', { name: 'Add existing' }).click()
		await page.getByRole('button', { name: 'Add', exact: true }).click()

		await expect(page.getByText('GitHub organization added to this workspace')).toBeVisible()
		expect(linkBody).toEqual({ installation_id: '4242' })
	})

	test('the entry point renders in both colour schemes', async ({ page, account }) => {
		await mockLinkable(page)
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await gotoIntegrations(page, account.workspaceId)
			await expect(page.getByRole('button', { name: 'Add existing' })).toBeVisible()
		}
	})

	test('is absent when there is nothing to add', async ({ page, account }) => {
		// The default state for every workspace: no reachable installations, so the
		// affordance must not appear at all rather than opening an empty dialog.
		await page.route('**/api/integrations/github/linkable', async (route) => {
			await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
		})
		await gotoIntegrations(page, account.workspaceId)

		await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible()
		await expect(page.getByRole('button', { name: 'Add existing' })).toHaveCount(0)
	})
})
