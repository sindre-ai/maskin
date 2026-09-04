import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The scope-drift reconnect prompt.
 *
 * OAuth tokens never gain scopes retroactively, so when the Slack provider
 * config grew the channel-history and search scopes, every existing install
 * kept a valid token that simply cannot do the new things. The integration
 * still reports `active` — this banner is the only thing that tells a human
 * re-consent is needed, so it has to be visible and actionable at every ship
 * gate viewport and in both colour schemes.
 *
 * Two copies exist. A Slack install missing any of `channels:history` /
 * `groups:history` / `mpim:history` gets named, actionable copy about history
 * access; anything else gets the generic "grant N new permissions" count. The
 * default stub below is missing history scopes — the realistic case for a token
 * predating the six-tool surface — so it renders the Slack-specific copy.
 *
 * `GET /api/integrations` is stubbed because reproducing a genuinely stale
 * token would mean completing a real Slack OAuth round-trip. The backend half
 * (that a stale install actually reports `needsReconnect`) is covered against
 * real Postgres in apps/dev's slack-reconnect integration test.
 */
const STALE_SLACK_INTEGRATION = {
	id: '11111111-1111-4111-8111-111111111111',
	provider: 'slack',
	status: 'active',
	externalId: 'T04AGPAM7HP',
	config: {},
	createdAt: '2026-08-21T07:02:33.124Z',
	updatedAt: '2026-08-21T07:04:34.059Z',
	missingScopes: ['channels:history', 'groups:history', 'search:read'],
	needsReconnect: true,
}

async function stubStaleSlack(
	page: import('@playwright/test').Page,
	workspaceId: string,
	overrides: Record<string, unknown> = {},
) {
	// Match the collection endpoint only — `/api/integrations/providers` must
	// still reach the real backend or no provider rows render at all.
	await page.route(
		(url) => url.pathname === '/api/integrations',
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{
						...STALE_SLACK_INTEGRATION,
						workspaceId,
						createdBy: '22222222-2222-4222-8222-222222222222',
						...overrides,
					},
				]),
			})
		},
	)
}

test.describe('Settings — Integrations scope-drift reconnect prompt', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows the update-needed label and a Reconnect action at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await stubStaleSlack(page, account.workspaceId)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			// `load` instead of `networkidle` — the app holds an SSE connection to
			// /api/events, so networkidle never fires. Brief settle after `load`.
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			// This stub is missing history scopes, so the Slack-specific copy wins
			// over the generic count — it names what the reconnect actually unlocks.
			await expect(
				page.getByText(
					'Reconnect required — Slack agents need history access to read channel backlog.',
				),
			).toBeVisible()

			// Reachable on touch: toBeVisible() also fails on opacity:0 / hover-only
			// reveals, which is the failure mode this assertion is guarding.
			const reconnect = page.getByRole('button', { name: 'Reconnect' })
			await expect(reconnect).toBeVisible()
			await expect(reconnect).toBeEnabled()

			// Disconnect must survive alongside it — reconnecting and disconnecting
			// are different intents and the row still needs both.
			await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()

			// The page itself must never scroll sideways, whatever the row contains.
			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflows).toBe(false)
		})
	}

	// The row uses the warning token for both the dot and the label. `bg-accent`
	// on a text-free indicator is near-invisible in light mode (a documented
	// recurring bug), so assert the prompt reads in both schemes rather than
	// trusting the token name.
	for (const scheme of ['light', 'dark'] as const) {
		test(`reconnect prompt is legible in ${scheme} mode`, async ({ page, account }) => {
			await stubStaleSlack(page, account.workspaceId)
			await page.emulateMedia({ colorScheme: scheme })
			await page.setViewportSize({ width: 1024, height: 768 })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			const label = page.getByText(
				'Reconnect required — Slack agents need history access to read channel backlog.',
			)
			await expect(label).toBeVisible()

			// Not transparent and not the same colour as the surface behind it.
			const { color, background } = await label.evaluate((el) => {
				const style = getComputedStyle(el)
				let node: HTMLElement | null = el as HTMLElement
				let background = 'rgba(0, 0, 0, 0)'
				while (node) {
					const bg = getComputedStyle(node).backgroundColor
					if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
						background = bg
						break
					}
					node = node.parentElement
				}
				return { color: style.color, background }
			})
			expect(color).not.toBe(background)
			expect(color).not.toMatch(/rgba\(.*,\s*0\)$/)

			await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
		})
	}

	test('a fully-scoped integration shows no Reconnect action', async ({ page, account }) => {
		// The negative case: without it, a banner stuck permanently on would pass
		// every assertion above.
		await stubStaleSlack(page, account.workspaceId, {
			missingScopes: [],
			needsReconnect: false,
		})
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')
		await page.waitForTimeout(300)

		await expect(page.getByText(/Update needed/)).toHaveCount(0)
		await expect(page.getByText(/Slack agents need history access/)).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0)
		// Still connected, so Disconnect remains.
		await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
	})

	test('generic count copy when the missing scopes are not history scopes', async ({
		page,
		account,
	}) => {
		await stubStaleSlack(page, account.workspaceId, {
			missingScopes: ['search:read', 'reactions:write'],
		})
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')
		await page.waitForTimeout(300)

		await expect(
			page.getByText('Update needed — reconnect to grant 2 new permissions'),
		).toBeVisible()
	})

	test('singular wording when exactly one scope is missing', async ({ page, account }) => {
		await stubStaleSlack(page, account.workspaceId, { missingScopes: ['search:read'] })
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await page.waitForLoadState('load')
		await page.waitForTimeout(300)

		await expect(
			page.getByText('Update needed — reconnect to grant 1 new permission'),
		).toBeVisible()
	})
})
