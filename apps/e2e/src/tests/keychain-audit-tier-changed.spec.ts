import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Keychain credential detail page: a tier_changed audit row reads "Tier changed to N"
 * (flag: keychain-settings-ui). Mock-free: the credential is vaulted through the real
 * POST /api/integrations/byo-apikey, the tier is set through the real PUT
 * /api/integrations/:id/tier (which writes the tier_changed row on the audit chain),
 * and the page reads the real audit-log route. The value below is obviously fake and
 * built at runtime so no token-shaped literal sits in the repo.
 */
const FAKE_SECRET = `lin_${'CANARY0123'.repeat(4)}`
const BASE = 'http://localhost:3000'

test.describe('Keychain audit log, tier_changed row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows "Tier changed to 2" and no raw ids @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.addInitScript(() => {
				localStorage.setItem('ff:keychain-settings-ui', 'on')
			})
			const headers = {
				Authorization: `Bearer ${account.apiKey}`,
				'X-Workspace-Id': account.workspaceId,
			}

			const created = await page.request.post(`${BASE}/api/integrations/byo-apikey`, {
				headers,
				data: { displayName: `Linear ${Date.now()}`, rawSecret: FAKE_SECRET },
			})
			expect(created.status()).toBe(201)
			const { integrationId } = (await created.json()) as { integrationId: string }

			const tier = await page.request.put(`${BASE}/api/integrations/${integrationId}/tier`, {
				headers,
				data: { tier: 2 },
			})
			expect(tier.status()).toBe(200)

			// The API returns detail for the tier_changed row and null for the create row.
			const audit = await page.request.get(`${BASE}/api/integrations/${integrationId}/audit-log`, {
				headers,
			})
			const body = (await audit.json()) as {
				entries: Array<{ action: string; detail: string | null }>
			}
			expect(body.entries.map((e) => [e.action, e.detail])).toEqual([
				['tier_changed', 'approver=;grant=;tier=2;ext='],
				['create', null],
			])

			await page.goto(`/${account.workspaceId}/settings/keychain/${integrationId}`)
			const log = page.getByRole('region', { name: 'Audit log' })
			await expect(log.getByText('Tier changed to 2')).toBeVisible({ timeout: 15_000 })
			await expect(log).toContainText('TIER CHANGED')
			// Rows for other actions render as before, and the detail text never shows.
			await expect(log).toContainText('added this credential')
			await expect(log).not.toContainText('approver=')
		})
	}
})
