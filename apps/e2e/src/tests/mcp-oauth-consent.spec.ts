import { type Page, expect, test } from '@playwright/test'
import { expectNoSeriousA11yViolations } from '../helpers/a11y.helper'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	E2E_OAUTH_CALLBACK as CALLBACK,
	type CaptureStub,
	E2E_OAUTH_ISSUER,
	E2E_OAUTH_PASSWORD,
	type OauthActor,
	E2E_OAUTH_STATE as STATE,
	authorizeParams,
	ensureOauthActor,
	startCaptureStub,
} from '../helpers/oauth-consent.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The consent page Claude sends a person to (/oauth/authorize) and the Claude tab of Settings > MCP.
// Preview, approve and deny are the real server routes; the only thing faked is Claude's own callback
// address, which the browser would otherwise leave the app for. The sign-in switch, the flag for the two
// fixed-id actors and the PostHog stub are set in playwright.config.ts.

const authorizeQuery = (overrides: Record<string, string> = {}) =>
	new URLSearchParams(authorizeParams(overrides)).toString()

const authorizePath = (overrides?: Record<string, string>) =>
	`/oauth/authorize?${authorizeQuery(overrides)}`

async function signIn(page: Page, actor: OauthActor) {
	await page.addInitScript(
		(data) => {
			localStorage.setItem('maskin-api-key', data.apiKey)
			localStorage.setItem(
				'maskin-actor',
				JSON.stringify({ id: data.id, name: data.name, type: 'human', email: data.email }),
			)
		},
		{ apiKey: actor.apiKey, id: actor.id, name: actor.name, email: actor.email },
	)
}

/** Answers Claude's callback address so the browser can "arrive" there, and records what it was sent. */
async function stubCallback(page: Page) {
	const arrivals: URL[] = []
	await page.route(`${CALLBACK}**`, async (route) => {
		arrivals.push(new URL(route.request().url()))
		await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Claude</h1>' })
	})
	return arrivals
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('Claude connector: consent page', () => {
	let single: OauthActor
	let multi: OauthActor
	let capture: CaptureStub

	test.beforeAll(async () => {
		single = await ensureOauthActor('single')
		multi = await ensureOauthActor('multi')
		const api = new TestAPI(multi.apiKey)
		const workspaces = await api.listWorkspaces()
		if (workspaces.length < 2) {
			// A trial actor may own a single workspace.
			await grantPlanHeadroom(multi.apiKey, workspaces[0].id)
			await api.createWorkspace('E2E Second Space')
		}
		capture = await startCaptureStub()
	})

	test.afterAll(async () => {
		await capture.close()
	})

	test('a signed-out visit signs in and returns with every parameter intact, at the full length', async ({
		page,
	}) => {
		// The realistic maximum: about 830 characters against the 2000 cap on the return path.
		const longState = `e2e-${'x'.repeat(508)}` // the longest state the server accepts (512)
		const query = authorizeQuery({ state: longState })
		expect(`/oauth/authorize?${query}`.length).toBeGreaterThan(800)

		await page.goto(`/oauth/authorize?${query}`)
		await expect(page).toHaveURL(/\/login\?/)
		await expect(page.getByText('Sign in to continue connecting your app to Maskin.')).toBeVisible()

		await page.getByPlaceholder('you@example.com').fill(single.email)
		await page.getByPlaceholder('Your password').fill(E2E_OAUTH_PASSWORD)
		await page.getByRole('button', { name: 'Sign in' }).click()

		await expect(page.getByRole('heading', { name: 'Connect Claude to Maskin' })).toBeVisible()
		const url = new URL(page.url())
		expect(url.pathname).toBe('/oauth/authorize')
		expect(url.searchParams.get('state')).toBe(longState)
		expect(url.search).toBe(`?${query}`)
	})

	test('one workspace is preselected and the consent step still shows', async ({ page }) => {
		await signIn(page, single)
		await page.goto(authorizePath())

		await expect(page.getByRole('heading', { name: 'Connect Claude to Maskin' })).toBeVisible()
		await expect(page.getByText(`Signed in as ${single.email}.`)).toBeVisible()
		await expect(page.getByText('Your only workspace')).toBeVisible()
		await expect(page.getByRole('radiogroup')).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Allow' })).toBeEnabled()
		await expect(page.getByText('Approved by Maskin')).toBeVisible()
		await expect(page.getByText('claude.ai').first()).toBeVisible()
		await expect(
			page.getByText(
				'It stays connected until you disconnect it in Settings > MCP. It also disconnects itself after 30 days unused.',
			),
		).toBeVisible()
		await expect(
			page.getByText(
				'Removing Maskin inside Claude may not end access. Disconnect it in Settings > MCP too.',
			),
		).toBeVisible()
	})

	test('two workspaces show a picker with nothing preselected', async ({ page }) => {
		await signIn(page, multi)
		await page.goto(authorizePath())

		await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
		const radios = page.getByRole('radio')
		await expect(radios).toHaveCount(2)
		await expect(page.getByRole('radio', { checked: true })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Allow' })).toBeDisabled()
		await expect(page.getByText('Choose a workspace to continue.')).toBeVisible()
		await expect(page.getByText('the workspace you choose').first()).toBeVisible()

		await radios.first().click()
		await expect(page.getByRole('button', { name: 'Allow' })).toBeEnabled()
	})

	test('Allow sends the browser to Claude with a code, the state and the issuer', async ({
		page,
	}) => {
		const arrivals = await stubCallback(page)
		capture.clear()
		await signIn(page, single)
		await page.goto(authorizePath())

		await page.getByRole('button', { name: 'Allow' }).click()
		await expect.poll(() => arrivals.length).toBe(1)

		const callback = arrivals[0]
		expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
		expect(callback.searchParams.get('code')).toMatch(/\S{20,}/)
		expect(callback.searchParams.get('state')).toBe(STATE)
		expect(callback.searchParams.get('iss')).toBe(E2E_OAUTH_ISSUER)

		await expect
			.poll(() => capture.events())
			.toEqual(
				expect.arrayContaining(['mcp_oauth_authorize_started', 'mcp_oauth_consent_approved']),
			)
	})

	test('Deny sends the browser back with access_denied and the state', async ({ page }) => {
		const arrivals = await stubCallback(page)
		capture.clear()
		await signIn(page, single)
		await page.goto(authorizePath())

		await page.getByRole('button', { name: 'Deny' }).click()
		await expect.poll(() => arrivals.length).toBe(1)

		expect(arrivals[0].searchParams.get('error')).toBe('access_denied')
		expect(arrivals[0].searchParams.get('state')).toBe(STATE)
		expect(arrivals[0].searchParams.has('code')).toBe(false)

		await expect
			.poll(() => capture.events())
			.toEqual(expect.arrayContaining(['mcp_oauth_consent_denied']))
		expect(capture.events()).not.toContain('mcp_oauth_consent_approved')
	})

	test('a return address Claude did not register shows an error on the page and goes nowhere', async ({
		page,
	}) => {
		const arrivals = await stubCallback(page)
		await signIn(page, single)
		await page.goto(authorizePath({ redirect_uri: 'https://evil.example/callback' }))

		await expect(
			page.getByRole('heading', { name: "This link doesn't match the app" }),
		).toBeVisible()
		await expect(page.getByText('Reference: bad_redirect_uri')).toBeVisible()
		await expect(page.getByRole('button', { name: /Allow|Back to Claude/ })).toHaveCount(0)
		await expect(page.getByRole('link', { name: 'Back to Claude' })).toHaveCount(0)
		expect(new URL(page.url()).pathname).toBe('/oauth/authorize')
		expect(arrivals).toHaveLength(0)
	})

	test('an incomplete request offers the way back only through the server-built link', async ({
		page,
	}) => {
		await signIn(page, single)
		await page.goto(authorizePath({ code_challenge: '' }))

		await expect(
			page.getByRole('heading', { name: "Claude's request is incomplete" }),
		).toBeVisible()
		await expect(page.getByText('Reference: pkce_missing')).toBeVisible()
		const back = page.getByRole('link', { name: 'Back to Claude' })
		const href = new URL((await back.getAttribute('href')) ?? '')
		expect(`${href.origin}${href.pathname}`).toBe(CALLBACK)
		expect(href.searchParams.get('error')).toBe('invalid_request')
	})

	test('an app Maskin has not approved shows the unknown-app error', async ({ page }) => {
		await signIn(page, single)
		await page.goto(authorizePath({ client_id: 'https://other.example/client.json' }))

		await expect(
			page.getByRole('heading', { name: "Maskin doesn't recognise this app" }),
		).toBeVisible()
		await expect(page.getByText('Reference: client_not_allowlisted')).toBeVisible()
	})

	test('with the flag off the page says it is not available yet', async ({ page }) => {
		// A fresh actor is not in the tester list, so preview answers 403.
		const outsider = await ensureOutsider()
		await signIn(page, outsider)
		await page.goto(authorizePath())

		await expect(
			page.getByRole('heading', { name: 'Not available for your account yet' }),
		).toBeVisible()
		await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the consent screen has no horizontal overflow and passes the accessibility scan at ${viewport.label}`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await signIn(page, multi)
			await page.goto(authorizePath())
			await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
			await page.getByRole('radio').first().click()

			await expectNoHorizontalOverflow(page)
			await expectNoSeriousA11yViolations(page, `oauth consent @${viewport.width}`)
			await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()
		})
	}
})

async function ensureOutsider(): Promise<OauthActor> {
	const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
	const actor = await createTestActor({
		name: `E2E Outsider ${unique}`,
		email: `e2e-outsider-${unique}@test.invalid`,
	})
	return { id: actor.id, name: actor.name, email: actor.email ?? '', apiKey: actor.api_key }
}
