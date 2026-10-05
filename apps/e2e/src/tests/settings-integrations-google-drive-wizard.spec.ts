import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Drive connect wizard and first-call state on the Drive detail page.
//
// The integrations list is route-mocked: a Drive row can only be produced by a
// real Google OAuth round trip, which no test account can complete. What the page
// does with that row is what is under test here. The stamp that drives it
// (config.first_tool_call_at) and its survival across a reconnect are covered
// against real Postgres in
// apps/dev/src/__tests__/integration/google-drive-first-tool-call.test.ts and
// integrations-oauth-callback.test.ts.

const STAMP = '2026-10-05T10:00:00.000Z'

const driveRow = (config: Record<string, unknown>) => ({
	id: '00000000-0000-4000-8000-0000000000d1',
	workspaceId: '00000000-0000-4000-8000-0000000000a1',
	provider: 'google-drive',
	status: 'active',
	externalId: 'priya@acme.test',
	config,
	actorId: null,
	createdBy: '00000000-0000-4000-8000-0000000000b1',
	createdAt: null,
	updatedAt: null,
	missingScopes: [],
	needsReconnect: false,
	grantedScopes: ['https://www.googleapis.com/auth/drive'],
})

async function mockIntegrations(page: Page, rows: unknown[]) {
	// Exact path only: /api/integrations/providers and friends must pass through.
	await page.route(
		(url) => url.pathname === '/api/integrations',
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(rows),
			})
		},
	)
}

async function gotoDrive(page: Page, workspaceId: string) {
	// The flag is off for the fixture actor; the client override flips it on.
	await page.addInitScript(() => localStorage.setItem('ff:google-drive-integration-ui', 'on'))
	await page.goto(`/${workspaceId}/settings/integrations/google-drive`)
	await page.waitForLoadState('load')
}

test.describe('Drive connect wizard', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`a workspace with no Google rows sees the wizard at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mockIntegrations(page, [])
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoDrive(page, account.workspaceId)

			await expect(
				page.getByRole('heading', { name: 'Connect your Google account for Drive' }),
			).toBeVisible()
			await expect(page.getByRole('button', { name: 'Continue with Google →' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
			await expect(page.getByTestId('drive-first-call')).toHaveCount(0)
		})
	}

	test('Continue shows Opening Google… while the connect request is in flight', async ({
		page,
		account,
	}) => {
		await mockIntegrations(page, [])
		await page.route('**/api/integrations/google-drive/connect', () => {
			// Never answered: the page stays in its loading state.
		})
		await gotoDrive(page, account.workspaceId)

		await page.getByRole('button', { name: 'Continue with Google →' }).click()
		await expect(page.getByRole('button', { name: 'Opening Google…' })).toBeDisabled()
	})

	test('a failed connect shows the sign-in message and keeps Continue available', async ({
		page,
		account,
	}) => {
		await mockIntegrations(page, [])
		await page.route('**/api/integrations/google-drive/connect', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'nope' } }),
			}),
		)
		await gotoDrive(page, account.workspaceId)

		await page.getByRole('button', { name: 'Continue with Google →' }).click()
		await expect(page.getByText('Sign-in was cancelled. Try again when ready.')).toBeVisible()
		await expect(page.getByRole('button', { name: 'Continue with Google →' })).toBeEnabled()
	})

	test('the wizard footer is keyboard reachable', async ({ page, account }) => {
		await mockIntegrations(page, [])
		await gotoDrive(page, account.workspaceId)
		await page.getByRole('heading', { name: 'Connect your Google account for Drive' }).waitFor()

		await page.getByRole('button', { name: 'Cancel' }).focus()
		await page.keyboard.press('Tab')
		await expect(page.getByRole('button', { name: 'Continue with Google →' })).toBeFocused()
	})
})

test.describe('Drive first-call state', () => {
	// Cards stack to 1 column on a phone, 2 at tablet widths, up to 4 on desktop.
	const EXPECTED_COLUMNS: Record<string, number> = {
		'iPhone (375×812)': 1,
		'iPad portrait (768×1024)': 2,
		'iPad landscape (1024×768)': 2,
	}

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows eight cards and a labelled sample until the first tool call at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mockIntegrations(page, [driveRow({})])
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoDrive(page, account.workspaceId)

			await expect(
				page.getByRole('heading', { name: 'Drive is connected. Point your agents at a file.' }),
			).toBeVisible()
			await expect(page.getByTestId('drive-jtbd-card')).toHaveCount(8)
			await expect(
				page.getByText("Sample notification (what you'll see when it fires)"),
			).toBeVisible()

			const columns = await page
				.getByTestId('drive-jtbd-grid')
				.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
			expect(columns).toBe(EXPECTED_COLUMNS[viewport.label])

			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflows).toBe(false)
		})
	}

	test('gives way to the connected detail once first_tool_call_at is set', async ({
		page,
		account,
	}) => {
		await mockIntegrations(page, [driveRow({ first_tool_call_at: STAMP })])
		await gotoDrive(page, account.workspaceId)

		await expect(page.getByTestId('scope-list')).toBeVisible()
		await expect(page.getByTestId('drive-first-call')).toHaveCount(0)
	})
})
