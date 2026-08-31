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
		slug: 'w0123_keyed',
		name: 'keyed-service',
		kind: 'openapi' as const,
		removable: true,
		url: 'https://api.example.com/openapi.json',
		connected: false,
		authKinds: ['api_key'] as const,
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
			await expect(section(page).getByText('petstore', { exact: true })).toBeVisible()

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

	test('asks for a secret before connecting an api-key integration', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })

		let connectBody: { auth?: { type?: string; value?: string } } | null = null
		await page.route('**/api/tool-broker/integrations/*/connect', async (route) => {
			connectBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ address: 'tools.x.org.shared' }),
			})
		})

		await gotoIntegrations(page, account.workspaceId)

		await section(page)
			.getByRole('listitem')
			.filter({ hasText: 'keyed-service' })
			.getByRole('button', { name: 'Connect…' })
			.click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// A secret must not be a plain text field.
		const field = dialog.getByLabel('API key')
		await expect(field).toHaveAttribute('type', 'password')
		await field.fill('sk-test-123')
		await dialog.getByRole('button', { name: 'Connect', exact: true }).click()

		await expect.poll(() => connectBody?.auth?.type, { timeout: 10000 }).toBe('api_key')
		expect(connectBody?.auth?.value).toBe('sk-test-123')
		await expect(dialog).toBeHidden()
	})

	test('infers an OpenAPI spec from the URL and tells the user', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: [] })
		await gotoIntegrations(page, account.workspaceId)

		await section(page).getByRole('button', { name: 'Add by URL' }).click()
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

const CATALOG = [
	{
		id: 'c1',
		name: 'Sentry',
		description: 'Errors and releases',
		domain: 'sentry.dev',
		iconPath: 'tool-broker/icons/sentry.dev',
		connectKind: 'mcp' as const,
		endpointUrl: 'https://mcp.sentry.dev/mcp',
		authKind: 'oauth2' as const,
		supportsDcr: true,
	},
	{
		id: 'c2',
		name: 'Wikipedia',
		description: 'Reference lookups',
		domain: 'wikipedia.example',
		iconPath: null,
		connectKind: 'mcp' as const,
		endpointUrl: 'https://mcp.wikipedia.example/mcp',
		authKind: 'none' as const,
		supportsDcr: false,
	},
	{
		id: 'c3',
		name: 'Legacy Thing',
		description: 'Needs a client configured by hand',
		domain: 'legacy.example',
		iconPath: null,
		connectKind: 'mcp' as const,
		endpointUrl: 'https://mcp.legacy.example/mcp',
		authKind: 'oauth2' as const,
		supportsDcr: false,
	},
	{
		// api_key with supportsDcr false — the shape that used to be lumped in with
		// Legacy Thing and disabled, despite the key dialog handling it fine.
		id: 'c4',
		name: 'Keyed Service',
		description: 'Authenticates with an API key',
		domain: 'keyed.example',
		iconPath: null,
		connectKind: 'mcp' as const,
		endpointUrl: 'https://mcp.keyed.example/mcp',
		authKind: 'api_key' as const,
		supportsDcr: false,
	},
]

const stubCatalog = async (
	page: import('@playwright/test').Page,
	catalog: typeof CATALOG = CATALOG,
) => {
	await page.route('**/api/tool-broker/catalog*', async (route) => {
		const url = new URL(route.request().url())
		const q = (url.searchParams.get('q') ?? '').toLowerCase()
		const matched = q ? catalog.filter((e) => e.name.toLowerCase().includes(q)) : catalog

		// Page the way the real route does, so `total` stays the count of all
		// matches while `entries` is only this slice. A stub that ignores offset
		// would let a broken next-page request still look like it worked.
		const limit = Number(url.searchParams.get('limit')) || matched.length
		const offset = Number(url.searchParams.get('offset')) || 0
		const entries = matched.slice(offset, offset + limit)
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ entries, total: matched.length }),
		})
	})
}

test.describe('catalogue browser', () => {
	test.beforeEach(async ({ page, account }) => {
		expect(account.workspaceId).toBeTruthy()
		await page.addInitScript(() => localStorage.setItem('ff:tool-broker', 'on'))
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`browses and adds an integration at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
			await stubCatalog(page)

			let added: { url?: string; name?: string } | null = null
			await page.route('**/api/tool-broker/integrations', async (route) => {
				added = route.request().postDataJSON()
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ slug: 'w0123_sentry' }),
				})
			})

			await gotoIntegrations(page, account.workspaceId)

			const browse = section(page).getByRole('button', { name: 'Browse' })
			await expect(browse).toBeVisible({ timeout: 10000 })
			await browse.click()

			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Sentry')).toBeVisible()

			await dialog
				.getByRole('listitem')
				.filter({ hasText: 'Sentry' })
				.getByRole('button', { name: 'Add' })
				.click()

			// Adding sends the PROVIDER's endpoint — the catalogue's own source is
			// never part of what the browser sends.
			await expect.poll(() => added?.url, { timeout: 10000 }).toBe('https://mcp.sentry.dev/mcp')
			expect(added?.name).toBe('Sentry')
		})
	}

	test('filters as you search', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)
		await gotoIntegrations(page, account.workspaceId)

		await section(page).getByRole('button', { name: 'Browse' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByLabel('Search').fill('sentry')

		await expect(dialog.getByText('Sentry')).toBeVisible()
		await expect(dialog.getByText('Wikipedia')).toHaveCount(0)
	})

	test('says so up front when an entry cannot be connected', async ({ page, account }) => {
		// Better than letting someone click Add and hit a refusal two steps later.
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)
		await gotoIntegrations(page, account.workspaceId)

		await section(page).getByRole('button', { name: 'Browse' }).click()
		const row = page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'Legacy Thing' })

		await expect(row.getByText('Needs setup')).toBeVisible()
		await expect(row.getByRole('button', { name: 'Add' })).toBeDisabled()
	})

	test('marks an entry that needs no sign-in', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)
		await gotoIntegrations(page, account.workspaceId)

		await section(page).getByRole('button', { name: 'Browse' }).click()
		const row = page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'Wikipedia' })

		await expect(row.getByText('No sign-in')).toBeVisible()
		await expect(row.getByRole('button', { name: 'Add' })).toBeEnabled()
	})

	test('icons are served from our own origin, never the catalogue source', async ({
		page,
		account,
	}) => {
		// The leak this whole design exists to prevent: an upstream icon URL would
		// put that hostname in every page view.
		const external: string[] = []
		page.on('request', (req) => {
			const host = new URL(req.url()).host
			if (!host.includes('localhost') && !host.includes('127.0.0.1')) external.push(req.url())
		})

		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)
		await gotoIntegrations(page, account.workspaceId)
		await section(page).getByRole('button', { name: 'Browse' }).click()
		await expect(page.getByRole('dialog').getByText('Sentry')).toBeVisible()

		expect(external).toEqual([])
	})

	test('renders in both light and dark', async ({ page, account }) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await gotoIntegrations(page, account.workspaceId)
			await section(page).getByRole('button', { name: 'Browse' }).click()

			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Sentry')).toBeVisible({ timeout: 10000 })
			await expect(dialog.getByText('No sign-in')).toBeVisible()
			await page.keyboard.press('Escape')
		}
	})
})

test.describe('catalogue browser — paging', () => {
	// 120 entries against a page size of 50: three pages, and the last one short.
	const MANY = Array.from({ length: 120 }, (_, i) => ({
		id: `p${i}`,
		// Zero-padded so the stub's order matches the route's name ordering.
		name: `Provider ${String(i).padStart(3, '0')}`,
		description: 'Generated',
		domain: `p${i}.example`,
		iconPath: null,
		connectKind: 'mcp' as const,
		endpointUrl: `https://mcp.p${i}.example/mcp`,
		authKind: 'none' as const,
		supportsDcr: false,
	}))

	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:tool-broker', 'on'))
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`loads more as you scroll at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
			await stubCatalog(page, MANY)

			await gotoIntegrations(page, account.workspaceId)
			await section(page).getByRole('button', { name: 'Browse' }).click()

			const dialog = page.getByRole('dialog')
			const rows = dialog.getByRole('listitem')

			// First page only, and the footer says so rather than implying this is all.
			await expect(rows).toHaveCount(50, { timeout: 10000 })
			await expect(dialog.getByText('50 of 120')).toBeVisible()

			// This is the whole point: reaching the end of the list loads the rest,
			// with no button to press.
			await rows.last().scrollIntoViewIfNeeded()
			await expect(rows).toHaveCount(100, { timeout: 10000 })

			await rows.last().scrollIntoViewIfNeeded()
			await expect(rows).toHaveCount(120, { timeout: 10000 })

			// Exhausted: the count stops being a fraction.
			await expect(dialog.getByText('All 120')).toBeVisible()
			await expect(dialog.getByText('Provider 119')).toBeVisible()
		})
	}

	test('a page is never requested twice for the same scroll position', async ({
		page,
		account,
	}) => {
		// The sentinel stays on screen after a page lands, so an observer that does
		// not stand down while fetching fires the same request repeatedly.
		const offsets: string[] = []
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await page.route('**/api/tool-broker/catalog*', async (route) => {
			const url = new URL(route.request().url())
			offsets.push(url.searchParams.get('offset') ?? '0')
			const offset = Number(url.searchParams.get('offset')) || 0
			const limit = Number(url.searchParams.get('limit')) || 50
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ entries: MANY.slice(offset, offset + limit), total: MANY.length }),
			})
		})

		await gotoIntegrations(page, account.workspaceId)
		await section(page).getByRole('button', { name: 'Browse' }).click()

		const rows = page.getByRole('dialog').getByRole('listitem')
		await expect(rows).toHaveCount(50, { timeout: 10000 })
		await rows.last().scrollIntoViewIfNeeded()
		await expect(rows).toHaveCount(100, { timeout: 10000 })

		expect(offsets).toEqual([...new Set(offsets)])
	})

	test('searching starts a fresh list rather than appending to the old one', async ({
		page,
		account,
	}) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page, MANY)

		await gotoIntegrations(page, account.workspaceId)
		await section(page).getByRole('button', { name: 'Browse' }).click()

		const dialog = page.getByRole('dialog')
		const rows = dialog.getByRole('listitem')
		await expect(rows).toHaveCount(50, { timeout: 10000 })

		await dialog.getByLabel('Search').fill('Provider 007')
		await expect(rows).toHaveCount(1, { timeout: 10000 })
		await expect(dialog.getByText('All 1 matching')).toBeVisible()
	})
})

test.describe('catalogue browser — what each entry will ask of you', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:tool-broker', 'on'))
	})

	test('an api-key entry can be added, and says a key will be needed', async ({
		page,
		account,
	}) => {
		// Regression: `supportsDcr` is an OAuth property. Reading it as a general
		// "can we connect this" flag disabled every api-key entry whose provider
		// happens not to self-register an OAuth client — 18 of them in the live
		// catalogue — even though pasting a key is a path we fully support.
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)

		let added: { url?: string } | null = null
		await page.route('**/api/tool-broker/integrations', async (route) => {
			added = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ slug: 'w0123_keyed' }),
			})
		})

		await gotoIntegrations(page, account.workspaceId)
		await section(page).getByRole('button', { name: 'Browse' }).click()

		const row = page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'Keyed Service' })
		await expect(row.getByText('Needs a key')).toBeVisible()
		await expect(row.getByText('Needs setup')).toHaveCount(0)

		const addButton = row.getByRole('button', { name: 'Add' })
		await expect(addButton).toBeEnabled()
		await addButton.click()
		await expect.poll(() => added?.url, { timeout: 10000 }).toBe('https://mcp.keyed.example/mcp')
	})

	test('only an OAuth provider that will not self-register is blocked', async ({
		page,
		account,
	}) => {
		await stubBroker(page, { configured: true, available: true, integrations: INTEGRATIONS })
		await stubCatalog(page)
		await gotoIntegrations(page, account.workspaceId)
		await section(page).getByRole('button', { name: 'Browse' }).click()

		const dialog = page.getByRole('dialog')
		// Exactly one of the four fixtures qualifies.
		await expect(dialog.getByText('Needs setup')).toHaveCount(1)
		await expect(
			dialog.getByRole('listitem').filter({ hasText: 'Legacy Thing' }).getByText('Needs setup'),
		).toBeVisible()
	})
})
