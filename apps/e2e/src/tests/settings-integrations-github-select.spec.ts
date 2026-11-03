import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Choosing an org after GitHub user authorization.
//
// GitHub installs its App once per org, so sending a second workspace to
// `installations/new` dead-ends on the configure page. Connect now goes through
// `login/oauth/authorize` instead, which always returns; the callback asks
// GitHub which installations the authorizing user can reach and — when there is
// more than one — redirects back here with `?select_github=<pending row id>`
// for the user to pick.
//
// The pending row is route-mocked: producing a real one would need a genuine
// GitHub App user-authorization round-trip, which no test account can perform.
// The finalize call is covered against real Postgres in
// apps/dev/src/__tests__/integration/github-installation-selection.test.ts.

const PENDING_ID = '00000000-0000-4000-8000-0000000000aa'

const SELECTION = {
	integrationId: PENDING_ID,
	installations: [
		{ installationId: '146523409', ownerLogin: 'sindre-ai' },
		{ installationId: '154364583', ownerLogin: 'vaerksted-ai' },
	],
}

async function mockPendingSelection(page: Page) {
	await page.route('**/api/integrations/github/pending-selection/*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(SELECTION),
		})
	})
}

async function gotoSelect(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/integrations?select_github=${PENDING_ID}`)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — Integrations — choose a GitHub org after authorization', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`lists every authorized org and its action at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mockPendingSelection(page)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoSelect(page, account.workspaceId)

			await expect(
				page.getByRole('heading', { name: 'Choose a GitHub organization' }),
			).toBeVisible()

			// Both orgs are offered — this is the whole point of the picker.
			await expect(page.getByText('sindre-ai')).toBeVisible()
			await expect(page.getByText('vaerksted-ai')).toBeVisible()

			// toBeVisible() checks opacity + visibility, so a hover-only reveal
			// (unreachable on touch) fails here rather than passing silently.
			const connectButtons = page.getByRole('button', { name: 'Connect', exact: true })
			await expect(connectButtons).toHaveCount(2)
			await expect(connectButtons.first()).toBeVisible()
			await expect(connectButtons.last()).toBeVisible()
		})
	}

	test('binds the chosen org and reports success', async ({ page, account }) => {
		await mockPendingSelection(page)
		let selectBody: unknown = null
		await page.route('**/api/integrations/github/select-installation', async (route) => {
			selectBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					id: '00000000-0000-4000-8000-000000000001',
					workspaceId: account.workspaceId,
					provider: 'github',
					status: 'active',
					externalId: '146523409',
					config: { owner_login: 'sindre-ai' },
					createdBy: account.actorId,
					createdAt: null,
					updatedAt: null,
				}),
			})
		})

		await gotoSelect(page, account.workspaceId)
		await page.getByRole('button', { name: 'Connect', exact: true }).first().click()

		await expect(page.getByText('GitHub organization connected')).toBeVisible()
		expect(selectBody).toEqual({
			integration_id: PENDING_ID,
			installation_id: '146523409',
		})

		// The dialog closes and the query param is cleared, so a reload or a back
		// navigation does not reopen a selection that has already been made.
		await expect(page.getByRole('heading', { name: 'Choose a GitHub organization' })).toHaveCount(0)
		expect(new URL(page.url()).searchParams.get('select_github')).toBeNull()
	})

	test('renders in both colour schemes', async ({ page, account }) => {
		await mockPendingSelection(page)
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await gotoSelect(page, account.workspaceId)
			await expect(page.getByText('sindre-ai')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Connect', exact: true }).first()).toBeVisible()
		}
	})

	test('does not open without the query param', async ({ page, account }) => {
		// The default state for every workspace: no selection pending, so the
		// dialog must stay shut rather than flashing an empty picker.
		await mockPendingSelection(page)
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')
		await page.waitForTimeout(300)

		await expect(page.getByRole('heading', { name: 'Choose a GitHub organization' })).toHaveCount(0)
	})
})
