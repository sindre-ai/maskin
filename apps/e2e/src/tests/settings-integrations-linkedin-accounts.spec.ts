import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// LinkedIn installs are per workspace member, not per workspace: the partial
// uniques in packages/db/src/schema.ts allow one row per (workspace, actor),
// and GET /api/integrations returns every row in the workspace. So the page has
// to list them like GitHub orgs and tell "my account" from "a colleague's" —
// before this, one member connecting made every member see a bare Disconnect.
//
// The rows are route-mocked: a real one needs a completed LinkedIn hosted-auth
// handshake against a live LinkedIn account, which no test account can have.
// The per-actor keying of the write path is covered against real Postgres in
// apps/dev/src/__tests__/integration/.

const COLLEAGUE_ACTOR_ID = '00000000-0000-4000-8000-0000000000c0'

function linkedInRow(id: string, actorId: string, externalId: string, workspaceId: string) {
	return {
		id,
		workspaceId,
		provider: 'linkedin-unipile',
		status: 'active',
		externalId,
		config: {},
		actorId,
		createdBy: actorId,
		createdAt: null,
		updatedAt: null,
	}
}

/** Serve the integrations list as `rows`, leaving every other route real. */
async function mockIntegrations(page: Page, rows: unknown[]) {
	await page.route('**/api/integrations', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(rows),
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

/** The group collapses when there is a single install; open it if it is shut. */
async function expandLinkedIn(page: Page) {
	const header = page.getByRole('button', { name: /LinkedIn/ })
	if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
}

test.describe('Settings — Integrations — LinkedIn accounts', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`lists every connected account and marks your own at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mockIntegrations(page, [
				linkedInRow(
					'11111111-0000-4000-8000-000000000001',
					account.actorId,
					'acct-mine',
					account.workspaceId,
				),
				linkedInRow(
					'11111111-0000-4000-8000-000000000002',
					COLLEAGUE_ACTOR_ID,
					'acct-theirs',
					account.workspaceId,
				),
			])
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoIntegrations(page, account.workspaceId)

			await expect(page.getByText('2 connected accounts')).toBeVisible()
			await expandLinkedIn(page)

			// Both accounts are listed, each identified by its stable account id.
			await expect(page.getByText('Account acct-mine')).toBeVisible()
			await expect(page.getByText('Account acct-theirs')).toBeVisible()
			// Exactly one row is the caller's. toBeVisible() checks opacity +
			// visibility, so a hover-only reveal would fail here on touch.
			await expect(page.getByText('(you)')).toHaveCount(1)
			await expect(page.getByText('(you)')).toBeVisible()

			// Already connected: no second account offered to this member.
			await expect(page.getByRole('button', { name: /Connect your account/ })).toHaveCount(0)
		})
	}

	test('offers a member who has not connected a way in, rather than a bare Disconnect', async ({
		page,
		account,
	}) => {
		// Only a colleague has connected — the case that previously rendered as
		// "Disconnect" to someone who had never connected anything.
		await mockIntegrations(page, [
			linkedInRow(
				'11111111-0000-4000-8000-000000000002',
				COLLEAGUE_ACTOR_ID,
				'acct-theirs',
				account.workspaceId,
			),
		])
		await gotoIntegrations(page, account.workspaceId)
		await expandLinkedIn(page)

		await expect(page.getByText('Account acct-theirs')).toBeVisible()
		await expect(page.getByText('(you)')).toHaveCount(0)
		await expect(page.getByRole('button', { name: /Connect your account/ })).toBeVisible()
	})

	test('states the per-identity price in both colour schemes', async ({ page, account }) => {
		await mockIntegrations(page, [
			linkedInRow(
				'11111111-0000-4000-8000-000000000001',
				account.actorId,
				'acct-mine',
				account.workspaceId,
			),
		])
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await gotoIntegrations(page, account.workspaceId)
			// The charge is per connected identity, so it must stay stated once a
			// workspace already has one — not only on the pre-connect card.
			await expect(page.getByText(/\$49\/month per connected identity/)).toBeVisible()
			await expandLinkedIn(page)
			await expect(page.getByText('Account acct-mine')).toBeVisible()
		}
	})
})
