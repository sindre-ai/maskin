import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The tool-broker settings section.
//
// The backend it talks to is a separate self-hosted service that is NOT running
// in CI, so `/api/tool-broker` is intercepted here. That is deliberate rather
// than a shortcut: without it the section would report `configured: false` and
// render nothing, and the spec would assert an empty page while claiming to
// cover the feature. Interception makes the populated state deterministic, which
// is the state that has interaction worth gating.
//
// Ordering note, same as new-design.spec: `account` is requested in beforeEach
// because init scripts run in registration order, and a fixture requested only
// by the test body is instantiated after the hooks — the flag override has to
// register after the auth fixture's own scripts.

const INTEGRATIONS = [
	{
		slug: 'w0123_deepwiki',
		name: 'deepwiki',
		kind: 'mcp' as const,
		removable: true,
		url: 'https://mcp.example.com/mcp',
		connected: true,
		authKinds: ['none'] as const,
	},
	{
		slug: 'w0123_petstore',
		name: 'petstore',
		kind: 'openapi' as const,
		removable: true,
		url: 'https://api.example.com/openapi.json',
		connected: false,
		authKinds: ['none'] as const,
	},
	{
		slug: 'w0123_linear',
		name: 'linear',
		kind: 'mcp' as const,
		removable: true,
		url: 'https://mcp.linear.app/mcp',
		connected: false,
		authKinds: ['oauth'] as const,
	},
]

/** Intercept the tool-broker API with a given payload. */
const stubBroker = async (
	page: import('@playwright/test').Page,
	body: {
		configured: boolean
		available: boolean
		integrations: typeof INTEGRATIONS
	},
) => {
	await page.route('**/api/tool-broker', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(body),
		})
	})
}

/**
 * The tool-broker section only.
 *
 * The OAuth provider list below it has its own Connect buttons — nine on a
 * seeded workspace — so an unscoped role locator is a strict-mode violation.
 * Scoping by the section's accessible name also asserts it is a real labelled
 * region rather than an anonymous div.
 */
const section = (page: import('@playwright/test').Page) => page.getByLabel('Connected by URL')

const gotoIntegrations = async (
	page: import('@playwright/test').Page,
	workspaceId: string,
): Promise<void> => {
	await page.goto(`/${workspaceId}/settings/integrations`)
}

test.describe('tool-broker section', () => {
	test.beforeEach(async ({ page, account }) => {
		expect(account.workspaceId).toBeTruthy()
		await page.addInitScript(() => localStorage.setItem('ff:tool-broker', 'on'))
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`lists integrations and distinguishes connected state at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })

			await gotoIntegrations(page, account.workspaceId)

			await expect(page.getByRole('heading', { name: 'Connected by URL' })).toBeVisible({
				timeout: 10000,
			})
			await expect(section(page).getByText('deepwiki')).toBeVisible()
			await expect(section(page).getByText('petstore')).toBeVisible()

			// The distinction that matters: present in the workspace is not the same
			// as usable. One row offers Disconnect, the other offers Connect.
			await expect(section(page).getByRole('button', { name: 'Disconnect' })).toBeVisible()
			await expect(
				section(page).getByRole('button', { name: 'Connect', exact: true }),
			).toBeVisible()
		})

		test(`opens the add dialog and submits a URL at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })

			let posted: { url?: string; kind?: string } | null = null
			await page.route('**/api/tool-broker/integrations', async (route) => {
				posted = route.request().postDataJSON()
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ slug: 'w0123_example' }),
				})
			})

			await gotoIntegrations(page, account.workspaceId)

			// Touch-reachable: `toBeVisible` checks opacity and visibility, so a
			// hover-only control would fail here at 375px.
			const addButton = section(page).getByRole('button', { name: 'Add', exact: true })
			await expect(addButton).toBeVisible({ timeout: 10000 })
			await addButton.click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()
			await dialog.getByLabel('URL').fill('https://mcp.example.com/mcp')
			await dialog.getByRole('button', { name: 'Add', exact: true }).click()

			await expect.poll(() => posted?.url, { timeout: 10000 }).toBe('https://mcp.example.com/mcp')
			expect(posted?.kind).toBe('mcp')
			// The dialog closes on success rather than leaving the user guessing.
			await expect(dialog).toBeHidden()
		})
	}

	test('sends the user to the provider for an OAuth integration', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })

		let connectBody: { auth?: { type?: string } } | null = null
		await page.route('**/api/tool-broker/integrations/*/connect', async (route) => {
			connectBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				// The OAuth branch answers with a URL instead of a connection.
				body: JSON.stringify({ authorizationUrl: 'https://mcp.linear.app/authorize?client_id=x' }),
			})
		})
		// Stop the real navigation; asserting we tried is the point.
		await page.route('https://mcp.linear.app/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<html>consent</html>' }),
		)

		await gotoIntegrations(page, account.workspaceId)

		// The ellipsis is the affordance: this click leaves Maskin.
		await section(page)
			.getByRole('listitem')
			.filter({ hasText: 'linear' })
			.getByRole('button', { name: 'Connect…' })
			.click()

		await expect.poll(() => connectBody?.auth?.type, { timeout: 10000 }).toBe('oauth')
		await expect.poll(() => page.url(), { timeout: 10000 }).toContain('mcp.linear.app')
	})

	test('infers an OpenAPI spec from the URL and tells the user', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: [] })
		await gotoIntegrations(page, account.workspaceId)

		await section(page).getByRole('button', { name: 'Add integration' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByLabel('URL').fill('https://api.example.com/openapi.json')

		// The user should be able to see what was inferred before submitting.
		await expect(dialog.getByText('Detected as an OpenAPI spec')).toBeVisible()
	})

	test('renders in both light and dark', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await gotoIntegrations(page, account.workspaceId)

			const heading = page.getByRole('heading', { name: 'Connected by URL' })
			await expect(heading).toBeVisible({ timeout: 10000 })
			// Semantic tokens only, so the state text must stay legible in both —
			// this is the `text-accent`-invisible-in-light-mode class of bug.
			// Scoped to one row: several rows are unconnected, so an unscoped text
			// locator is a strict-mode violation.
			await expect(
				section(page)
					.getByRole('listitem')
					.filter({ hasText: 'petstore' })
					.getByText('Not connected'),
			).toBeVisible()
		}
	})

	test('reports an outage without pretending there are no integrations', async ({
		page,
		account,
	}) => {
		await stubBroker(page, { configured: true, available: false, integrations: [] })
		await gotoIntegrations(page, account.workspaceId)

		// "Unavailable" and "none yet" are different states and must not look alike.
		await expect(section(page).getByText('Integrations are unavailable')).toBeVisible({
			timeout: 10000,
		})
		await expect(section(page).getByText('No integrations yet')).toHaveCount(0)
	})

	test('renders nothing when the backend is not configured', async ({ page, account }) => {
		await stubBroker(page, { configured: false, available: false, integrations: [] })
		await gotoIntegrations(page, account.workspaceId)

		// A deployment without the backend should not see a broken-looking section.
		await expect(page.getByRole('heading', { name: 'Connected by URL' })).toHaveCount(0)
		// The existing provider list is untouched — this change is additive.
		await expect(page.getByText('GitHub')).toBeVisible({ timeout: 10000 })
	})
})

test.describe('tool-broker flag off', () => {
	test.beforeEach(async ({ page, account }) => {
		expect(account.workspaceId).toBeTruthy()
		await page.addInitScript(() => localStorage.setItem('ff:tool-broker', 'off'))
	})

	test('hides the section and leaves the provider list intact', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await gotoIntegrations(page, account.workspaceId)

		await expect(page.getByText('GitHub')).toBeVisible({ timeout: 10000 })
		await expect(page.getByRole('heading', { name: 'Connected by URL' })).toHaveCount(0)
	})
})
