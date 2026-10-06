import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

/**
 * The Google Drive detail page (/settings/integrations/google-drive), behind
 * the google-drive-integration-ui flag.
 *
 * GET /api/integrations is stubbed because a Drive row only exists after a
 * real Google OAuth round trip. The backend half (that the list reports
 * grantedScopes from the stored token response) is covered against real
 * Postgres in apps/dev's slack-reconnect integration test. The connect POST is
 * stubbed with a webhook_url body so the client does not navigate to Google;
 * the spec asserts the request was sent, not that Google accepts it.
 *
 * The flag is switched with the client's test-only localStorage override, the
 * same way the Chats v4 specs do, so both sides of the boundary run without a
 * second actor. Dark mode is switched through the app's own maskin-theme key:
 * the app defaults to light and ignores prefers-color-scheme unless the stored
 * theme is "system", so emulateMedia alone would leave every "dark" run light.
 */
const FLAG_KEY = 'ff:google-drive-integration-ui'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

const WIDTHS = [
	{ width: 640, height: 900, label: '640' },
	{ width: 1024, height: 768, label: '1024' },
	{ width: 1280, height: 900, label: '1280' },
] as const

let rowCounter = 0

function integrationRow(
	workspaceId: string,
	provider: string,
	email: string,
	overrides: Record<string, unknown> = {},
) {
	rowCounter += 1
	return {
		id: `00000000-0000-4000-8000-${String(rowCounter).padStart(12, '0')}`,
		workspaceId,
		provider,
		status: 'active',
		externalId: email,
		config: {},
		createdBy: null,
		actorId: null,
		createdAt: '2026-10-05T10:00:00.000Z',
		updatedAt: '2026-10-05T10:00:00.000Z',
		missingScopes: [],
		needsReconnect: false,
		grantedScopes: [],
		...overrides,
	}
}

const driveRow = (workspaceId: string, email: string, overrides: Record<string, unknown> = {}) =>
	integrationRow(workspaceId, 'google-drive', email, {
		grantedScopes: ['openid', DRIVE_SCOPE],
		...overrides,
	})

async function stubIntegrations(page: Page, rows: unknown[]) {
	// Collection endpoint only: /api/integrations/providers must reach the real
	// backend or the providers list renders no rows.
	await page.route(
		(url) => url.pathname === '/api/integrations',
		(route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(rows),
			})
		},
	)
}

async function stubConnect(page: Page) {
	await page.route(
		(url) => url.pathname === '/api/integrations/google-drive/connect',
		(route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ webhook_url: 'https://e2e.invalid/not-used' }),
			}),
	)
}

async function setFlag(page: Page, value: 'on' | 'off') {
	await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
		key: FLAG_KEY,
		value,
	})
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((value) => localStorage.setItem('maskin-theme', value), theme)
}

async function openDetail(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/integrations/google-drive`)
	// `load`, not `networkidle`: the app holds an SSE connection to /api/events.
	await page.waitForLoadState('load')
}

async function expectNoSidewaysScroll(page: Page) {
	const overflows = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
	)
	expect(overflows).toBe(false)
}

test.describe('Settings — Google Drive detail page', () => {
	test('flag off: the route shows the not-available state and no Drive surface', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'off')
		await stubIntegrations(page, [driveRow(account.workspaceId, 'kai@acme.test')])
		await openDetail(page, account.workspaceId)

		await expect(page.getByText('Google Drive is not available yet')).toBeVisible()
		await expect(page.getByTestId('drive-detail')).toHaveCount(0)
		await expect(page.getByTestId('scope-list')).toHaveCount(0)
	})

	test('flag off: the providers list does not show a Drive row', async ({ page, account }) => {
		await setFlag(page, 'off')
		await stubIntegrations(page, [])
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')

		await expect(page.getByText('Slack', { exact: true }).first()).toBeVisible()
		await expect(page.getByText('Google Drive')).toHaveCount(0)
	})

	test('flag on: the providers list shows the Drive card with its New pill and a Details link', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'on')
		await stubIntegrations(page, [])
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')

		await expect(page.getByText('Google Drive')).toBeVisible()
		await expect(page.getByLabel('New', { exact: true })).toBeVisible()
		await expect(
			page.getByText('File bytes, Docs, Sheets, search, folder watch, write, comments.'),
		).toBeVisible()
		await expect(page.getByText('Free · Piggybacks on Google auth')).toBeVisible()

		await page.getByRole('link', { name: 'Details' }).click()
		await expect(page).toHaveURL(
			new RegExp(`/${account.workspaceId}/settings/integrations/google-drive$`),
		)
	})

	test('loading: a skeleton shows until the integrations resolve', async ({ page, account }) => {
		await setFlag(page, 'on')
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		await page.route(
			(url) => url.pathname === '/api/integrations',
			async (route) => {
				if (route.request().method() !== 'GET') return route.fallback()
				await gate
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify([]),
				})
			},
		)
		await openDetail(page, account.workspaceId)

		await expect(page.getByTestId('drive-detail-loading')).toBeVisible()
		await expect(page.getByTestId('drive-detail')).toHaveCount(0)
		release()
		await expect(page.getByTestId('drive-detail')).toBeVisible()
	})

	test('scope-add: banner and per-human CTA start the Drive connect flow', async ({
		page,
		account,
	}) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubConnect(page)
		await stubIntegrations(page, [
			integrationRow(ws, 'gmail', 'priya@acme.test'),
			integrationRow(ws, 'google-meet', 'priya@acme.test'),
			integrationRow(ws, 'gmail', 'kai@acme.test'),
			driveRow(ws, 'kai@acme.test'),
		])
		await openDetail(page, ws)

		await expect(page.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'scope-add')
		await expect(page.getByLabel('Partial')).toBeVisible()
		await expect(page.getByTestId('drive-mline')).toHaveText(
			'2 humans on Google · 1 has Drive · 1 needs scope add',
		)

		const banner = page.getByRole('status')
		await expect(banner).toHaveAttribute('aria-live', 'polite')
		await expect(banner.getByText('1 human needs to add Drive permissions')).toBeVisible()

		await expect(page.getByTestId('scope-row-priya@acme.test')).toHaveAttribute(
			'data-state',
			'is-missing',
		)
		await expect(page.getByTestId('scope-row-kai@acme.test')).toHaveAttribute(
			'data-state',
			'is-complete',
		)

		const bannerRequest = page.waitForRequest(
			(req) =>
				req.method() === 'POST' &&
				new URL(req.url()).pathname === '/api/integrations/google-drive/connect',
		)
		await banner.getByRole('button', { name: 'Grant for all →' }).click()
		await bannerRequest

		const rowRequest = page.waitForRequest(
			(req) =>
				req.method() === 'POST' &&
				new URL(req.url()).pathname === '/api/integrations/google-drive/connect',
		)
		await page
			.getByTestId('scope-row-priya@acme.test')
			.getByRole('button', { name: 'Add Drive permissions →' })
			.click()
		await rowRequest
	})

	test('connected: every human has Drive, no banner and no CTA', async ({ page, account }) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubIntegrations(page, [
			integrationRow(ws, 'gmail', 'priya@acme.test'),
			driveRow(ws, 'priya@acme.test'),
			driveRow(ws, 'kai@acme.test'),
		])
		await openDetail(page, ws)

		await expect(page.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'connected')
		await expect(page.getByLabel('Connected')).toBeVisible()
		await expect(page.getByTestId('drive-mline')).toHaveText('2 humans connected')
		await expect(page.getByRole('status')).toHaveCount(0)
		await expect(page.getByRole('button', { name: /Add Drive permissions/ })).toHaveCount(0)
		await expect(
			page.getByTestId('scope-row-kai@acme.test').getByLabel('Edit & comment on any file, granted'),
		).toBeVisible()
	})

	test('needs-reconnect: a Drive row that lost its scope shows the reconnect banner', async ({
		page,
		account,
	}) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubConnect(page)
		await stubIntegrations(page, [
			driveRow(ws, 'priya@acme.test'),
			driveRow(ws, 'kai@acme.test', { needsReconnect: true, grantedScopes: ['openid'] }),
		])
		await openDetail(page, ws)

		await expect(page.getByTestId('drive-detail')).toHaveAttribute(
			'data-variant',
			'needs-reconnect',
		)
		await expect(page.getByLabel('Attention')).toBeVisible()
		await expect(page.getByTestId('drive-mline')).toHaveText(
			'2 humans connected · 1 needs reconnect',
		)
		const banner = page.getByRole('status')
		await expect(banner.getByText('Reconnect Google — your token was invalidated')).toBeVisible()
		await expect(
			page
				.getByTestId('scope-row-kai@acme.test')
				.getByLabel('Edit & comment on any file, not granted'),
		).toBeVisible()

		const request = page.waitForRequest(
			(req) =>
				req.method() === 'POST' &&
				new URL(req.url()).pathname === '/api/integrations/google-drive/connect',
		)
		await banner.getByRole('button', { name: 'Reconnect →' }).click()
		await request
	})

	test('all-disconnected: the empty state has a Connect Drive button that starts the flow', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'on')
		await stubConnect(page)
		await stubIntegrations(page, [])
		await openDetail(page, account.workspaceId)

		await expect(page.getByTestId('drive-detail')).toHaveAttribute(
			'data-variant',
			'all-disconnected',
		)
		await expect(page.getByText('Drive is not connected')).toBeVisible()
		await expect(page.getByTestId('scope-list')).toHaveCount(0)

		const request = page.waitForRequest(
			(req) =>
				req.method() === 'POST' &&
				new URL(req.url()).pathname === '/api/integrations/google-drive/connect',
		)
		await page.getByRole('button', { name: 'Connect Drive' }).click()
		await request
	})

	test('omitted values stay omitted: no activity feed, idle line or read/write counts', async ({
		page,
		account,
	}) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubIntegrations(page, [driveRow(ws, 'priya@acme.test'), driveRow(ws, 'kai@acme.test')])
		await openDetail(page, ws)

		await expect(page.getByTestId('drive-detail')).toBeVisible()
		await expect(page.getByText('Recent Drive activity')).toHaveCount(0)
		await expect(page.getByText('No Drive reads yet')).toHaveCount(0)
		await expect(page.getByText(/\d+ (file reads|writes|folders watched)/)).toHaveCount(0)
	})

	for (const viewport of WIDTHS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`needs-reconnect fits at ${viewport.label}px in ${scheme} mode`, async ({
				page,
				account,
			}) => {
				const ws = account.workspaceId
				await setFlag(page, 'on')
				await stubIntegrations(page, [
					driveRow(ws, 'priya@acme.test'),
					driveRow(ws, 'kai@acme.test', { needsReconnect: true, grantedScopes: ['openid'] }),
				])
				await setTheme(page, scheme)
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await openDetail(page, ws)

				// Guard against a vacuous run: the theme class must really be applied.
				if (scheme === 'dark') {
					await expect(page.locator('html')).toHaveClass(/\bdark\b/)
				} else {
					await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
				}

				const banner = page.getByRole('status')
				await expect(banner).toBeVisible()
				await expect(banner.getByRole('button', { name: 'Reconnect →' })).toBeVisible()
				await expect(page.getByTestId('scope-list')).toBeVisible()
				await expectNoSidewaysScroll(page)
			})
		}
	}
})

/**
 * Folder watches section on the Drive detail page. The list and stop endpoints
 * are stubbed with a small in-memory store because a watch row only exists once
 * a real Drive connection has an agent watching a folder; their real behaviour
 * (jsonb rewrite, workspace scoping, 404s) is covered against Postgres in
 * apps/dev's google-drive-watched-folders integration test.
 */
const WATCHES_PATH = '/api/integrations/google-drive/watched-folders'

type WatchStub = {
	folderId: string
	name: string
	path: string | null
	addedAt: string | null
	lastFiredAt: string | null
	integrationId: string
	account: string | null
	triggers: { id: string; name: string }[]
}

function watchStub(folderId: string, overrides: Partial<WatchStub> = {}): WatchStub {
	return {
		folderId,
		name: `Folder ${folderId}`,
		path: null,
		addedAt: '2026-10-01T09:00:00.000Z',
		lastFiredAt: null,
		integrationId: '00000000-0000-4000-8000-0000000000aa',
		account: 'priya@acme.test',
		triggers: [],
		...overrides,
	}
}

async function stubWatches(page: Page, initial: WatchStub[]) {
	let watches = [...initial]
	const stopped: string[] = []
	await page.route(
		(url) => url.pathname.startsWith(WATCHES_PATH),
		(route) => {
			const { pathname } = new URL(route.request().url())
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(watches),
				})
			}
			const folderId = decodeURIComponent(pathname.slice(WATCHES_PATH.length + 1))
			if (!watches.some((w) => w.folderId === folderId)) {
				return route.fulfill({
					status: 404,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Folder watch not found' } }),
				})
			}
			stopped.push(folderId)
			watches = watches.filter((w) => w.folderId !== folderId)
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, folderId }),
			})
		},
	)
	return { stopped }
}

const LONG_PATH = 'My Drive/Customers/Acme Studio/Quarterly business reviews/2026/Board materials'

test.describe('Settings — Google Drive folder watches', () => {
	test('lists one row per watch in the folder-row format, with only sourced segments', async ({
		page,
		account,
	}) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubIntegrations(page, [driveRow(ws, 'priya@acme.test')])
		await stubWatches(page, [
			watchStub('f-rec', {
				name: 'Meet Recordings',
				path: 'My Drive',
				lastFiredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
				triggers: [{ id: '00000000-0000-4000-8000-0000000000bb', name: 'Post-call recap' }],
			}),
			watchStub('f-brief', { name: 'Customer briefs' }),
		])
		await openDetail(page, ws)

		await expect(page.getByRole('heading', { name: 'Folder watches' })).toBeVisible()
		await expect(page.getByTestId('folder-watch-list').getByRole('listitem')).toHaveCount(2)

		const rec = page.getByTestId('folder-watch-f-rec')
		await expect(rec).toContainText('My Drive/Meet Recordings')
		await expect(rec.getByTestId('folder-watch-meta')).toHaveText(
			'priya · triggers Post-call recap · last fired 2h ago',
		)
		// Nothing sources a trigger or a fire time for this one, so neither shows.
		await expect(
			page.getByTestId('folder-watch-f-brief').getByTestId('folder-watch-meta'),
		).toHaveText('priya')
		// Read and stop only: no add-a-watch control anywhere in the section.
		await expect(
			page.getByTestId('folder-watches').getByRole('button', { name: /add|new|create/i }),
		).toHaveCount(0)
	})

	test('Stop sends a DELETE for that folder and the row disappears', async ({ page, account }) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubIntegrations(page, [driveRow(ws, 'priya@acme.test')])
		const { stopped } = await stubWatches(page, [
			watchStub('f-a', { name: 'Meet Recordings' }),
			watchStub('f-b', { name: 'Customer briefs' }),
		])
		await openDetail(page, ws)

		const stop = page.getByRole('button', { name: 'Stop watch for Customer briefs' })
		await expect(stop).toBeVisible()
		const request = page.waitForRequest(
			(req) => req.method() === 'DELETE' && new URL(req.url()).pathname === `${WATCHES_PATH}/f-b`,
		)
		await stop.click()
		await request

		await expect(page.getByTestId('folder-watch-f-b')).toHaveCount(0)
		await expect(page.getByTestId('folder-watch-f-a')).toBeVisible()
		expect(stopped).toEqual(['f-b'])
	})

	test('stopping the last watch leaves the empty state, not a blank card', async ({
		page,
		account,
	}) => {
		const ws = account.workspaceId
		await setFlag(page, 'on')
		await stubIntegrations(page, [driveRow(ws, 'priya@acme.test')])
		await stubWatches(page, [watchStub('f-only', { name: 'Meet Recordings' })])
		await openDetail(page, ws)

		await page.getByRole('button', { name: 'Stop watch for Meet Recordings' }).click()
		await expect(page.getByText('No folders are being watched')).toBeVisible()
		await expect(page.getByTestId('folder-watch-list')).toHaveCount(0)
		await expect(page.getByRole('button', { name: /Stop watch/ })).toHaveCount(0)
	})

	test('with the flag off the section is unreachable and its endpoint is never called', async ({
		page,
		account,
	}) => {
		let called = false
		await page.route(
			(url) => url.pathname.startsWith(WATCHES_PATH),
			(route) => {
				called = true
				return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
			},
		)
		await setFlag(page, 'off')
		await stubIntegrations(page, [driveRow(account.workspaceId, 'priya@acme.test')])
		await openDetail(page, account.workspaceId)

		await expect(page.getByText('Google Drive is not available yet')).toBeVisible()
		await expect(page.getByTestId('folder-watches')).toHaveCount(0)
		expect(called).toBe(false)
	})

	for (const viewport of WIDTHS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`folder watches fit at ${viewport.label}px in ${scheme} mode`, async ({
				page,
				account,
			}) => {
				const ws = account.workspaceId
				await setFlag(page, 'on')
				await stubIntegrations(page, [driveRow(ws, 'priya@acme.test')])
				await stubWatches(page, [
					watchStub('f-long', { name: 'Q3 briefs', path: LONG_PATH }),
					watchStub('f-short', { name: 'Meet Recordings' }),
				])
				await setTheme(page, scheme)
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await openDetail(page, ws)

				if (scheme === 'dark') {
					await expect(page.locator('html')).toHaveClass(/\bdark\b/)
				} else {
					await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
				}

				// The long path is shortened at a folder boundary, never mid-name, and the
				// full path stays available to assistive tech and as the tooltip.
				const long = page.getByTestId('folder-watch-f-long')
				await expect(long).toContainText(
					'…/Quarterly business reviews/2026/Board materials/Q3 briefs',
				)
				await expect(long.locator('p[title]')).toHaveAttribute('title', `${LONG_PATH}/Q3 briefs`)

				for (const folder of ['Q3 briefs', 'Meet Recordings']) {
					await expect(
						page.getByRole('button', { name: new RegExp(`^Stop watch for .*${folder}$`) }),
					).toBeVisible()
				}
				await expectNoSidewaysScroll(page)
			})
		}
	}
})
