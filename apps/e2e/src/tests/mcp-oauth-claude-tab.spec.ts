import { expect, test } from '@playwright/test'
import { expectNoSeriousA11yViolations } from '../helpers/a11y.helper'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	E2E_OAUTH_API_ORIGIN,
	E2E_OAUTH_ISSUER,
	type OauthActor,
	connectClaude,
	disconnectAll,
	ensureOauthActor,
} from '../helpers/oauth-consent.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The Claude tab of Settings > MCP: the Add to Claude link, the Connected apps list and Disconnect.
// A connection is made through the real approve route (what Allow on the consent page calls), so the
// rows come from the real list. The flag is on for the fixed-id actor and off for a fresh one
// (playwright.config.ts).

async function signIn(page: import('@playwright/test').Page, actor: OauthActor) {
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

test.describe('Claude connector: Settings > MCP > Claude tab', () => {
	let actor: OauthActor
	let workspaceId: string
	let workspaceName: string

	test.beforeAll(async () => {
		actor = await ensureOauthActor('single')
		const [workspace] = await new TestAPI(actor.apiKey).listWorkspaces()
		workspaceId = workspace.id
		workspaceName = workspace.name
	})

	test.beforeEach(async () => {
		await disconnectAll(actor)
	})

	test('not connected: the tab opens first with a real Add to Claude link and the server URL', async ({
		page,
	}) => {
		await signIn(page, actor)
		await page.goto(`/${workspaceId}/settings/mcp`)

		const tab = page.getByRole('tab', { name: /^Claude\s*Sign in$/i })
		await expect(tab).toHaveAttribute('aria-selected', 'true')

		const add = page.getByRole('link', { name: 'Add to Claude' })
		const href = new URL((await add.getAttribute('href')) ?? '')
		expect(`${href.origin}${href.pathname}`).toBe('https://claude.ai/customize/connectors')
		expect(href.searchParams.get('modal')).toBe('add-custom-connector')
		expect(href.searchParams.get('connectorName')).toBe('Maskin')
		expect(href.searchParams.get('connectorUrl')).toBe(`${E2E_OAUTH_ISSUER}/mcp`)
		expect(href.toString()).not.toMatch(/ank_|mat_|mrt_|api_key/i)

		await expect(
			page.getByText('Click Add, then Connect. Sign in to Maskin when Claude asks.'),
		).toBeVisible()
		await expect(
			page.getByText(
				'On a Team or Enterprise plan? Ask your Claude admin to add Maskin, then click Connect.',
			),
		).toBeVisible()
		await expect(page.getByText(`${E2E_OAUTH_ISSUER}/mcp`, { exact: true })).toBeVisible()
	})

	test('the server URL shown is byte for byte the resource the server advertises', async ({
		page,
	}) => {
		await signIn(page, actor)
		await page.goto(`/${workspaceId}/settings/mcp`)

		const doc = await (
			await fetch(`${E2E_OAUTH_API_ORIGIN}/.well-known/oauth-protected-resource/mcp`)
		).json()
		await expect(page.getByText(doc.resource, { exact: true })).toBeVisible()
	})

	test('connected: a row per workspace, and Disconnect ends it without signing the person out', async ({
		page,
	}) => {
		await connectClaude(actor, workspaceId)
		await signIn(page, actor)
		await page.goto(`/${workspaceId}/settings/mcp`)

		await expect(page.getByRole('tab', { name: /^Claude\s*Connected$/i })).toHaveAttribute(
			'aria-selected',
			'true',
		)
		await expect(page.getByText(`Workspace: ${workspaceName}`)).toBeVisible()
		await expect(page.getByText(/^Connected \S+ \S+$/)).toBeVisible()
		await expect(page.getByRole('link', { name: 'Add to Claude' })).toHaveCount(0)

		await page.getByRole('button', { name: 'Disconnect' }).click()
		await expect(page.getByRole('heading', { name: 'Disconnect Claude?' })).toBeVisible()
		await expect(page.getByText(/Claude may then show "connection expired"/)).toBeVisible()
		await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()

		await expect(page.getByText('Claude disconnected')).toBeVisible()
		await expect(page.getByRole('link', { name: 'Add to Claude' })).toBeVisible()
		await expect(page.getByRole('tab', { name: /^Claude\s*Sign in$/i })).toBeVisible()

		// Still signed in: the key is kept and the settings page is still the page.
		expect(await page.evaluate(() => localStorage.getItem('maskin-api-key'))).toBe(actor.apiKey)
		expect(new URL(page.url()).pathname).toBe(`/${workspaceId}/settings/mcp`)
		const grants = await (
			await fetch(`${E2E_OAUTH_ISSUER}/api/oauth/grants`, {
				headers: { Authorization: `Bearer ${actor.apiKey}` },
			})
		).json()
		expect(grants).toEqual([])
	})

	test('without the flag and without a connection there is no Claude tab', async ({ page }) => {
		const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
		const outsider = await createTestActor({
			name: `E2E Outsider ${unique}`,
			email: `e2e-outsider-${unique}@test.invalid`,
		})
		const [workspace] = await new TestAPI(outsider.api_key).listWorkspaces()
		await signIn(page, {
			id: outsider.id,
			name: outsider.name,
			email: outsider.email ?? '',
			apiKey: outsider.api_key,
		})
		await page.goto(`/${workspace.id}/settings/mcp`)

		await expect(page.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
			'aria-selected',
			'true',
		)
		await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the connected list and the Disconnect dialog fit at ${viewport.label}`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await connectClaude(actor, workspaceId)
			await signIn(page, actor)
			await page.goto(`/${workspaceId}/settings/mcp`)

			await expect(page.getByText(`Workspace: ${workspaceName}`)).toBeVisible()
			const disconnect = page.getByRole('button', { name: 'Disconnect' })
			await expect(disconnect).toBeVisible()
			await expectNoHorizontalOverflow(page)

			await disconnect.click()
			await expect(page.getByRole('heading', { name: 'Disconnect Claude?' })).toBeVisible()
			await expectNoHorizontalOverflow(page)
			await expectNoSeriousA11yViolations(page, `claude tab dialog @${viewport.width}`)
		})
	}
})

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}
