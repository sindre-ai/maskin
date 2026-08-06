import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

// Workspaces default to byollmAllowed: false — the Maskin-provided LLM plan.
// Only ops-flagged exception workspaces may bring their own Claude
// subscription / API key / custom endpoint. See PR #970.
async function grantByollmAllowed(apiKey: string, workspaceId: string) {
	const res = await fetch(`${BASE}/api/workspaces/admin/${workspaceId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ byollm_allowed: true }),
	})
	if (!res.ok) {
		throw new Error(`Grant byollm_allowed failed: ${res.status} ${await res.text()}`)
	}
}

test.describe('BYOLLM entitlement gate — settings UI', () => {
	test('hides BYO controls and shows the platform-plan notice for a non-entitled workspace', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/settings/keys`)

		await expect(page.getByTestId('byollm-disabled-notice')).toBeVisible()
		await expect(page.getByTestId('byollm-disabled-notice')).toContainText(
			'Maskin-provided LLM plan',
		)
		await expect(page.getByTestId('claude-oauth-slots')).toHaveCount(0)
		await expect(page.getByText('LLM API Keys')).toHaveCount(0)
		await expect(page.getByText('Custom Model Endpoint (beta)')).toHaveCount(0)

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(page.getByTestId('byollm-disabled-notice')).toBeVisible()
		}
	})

	test('reveals BYO controls once the workspace is granted entitlement', async ({
		page,
		account,
	}) => {
		await grantByollmAllowed(account.apiKey, account.workspaceId)

		await page.goto(`/${account.workspaceId}/settings/keys`)

		await expect(page.getByTestId('byollm-disabled-notice')).toHaveCount(0)
		await expect(page.getByTestId('claude-oauth-slots')).toBeVisible()
		await expect(page.getByText('LLM API Keys')).toBeVisible()
		await expect(page.getByText('Custom Model Endpoint (beta)')).toBeVisible()

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(page.getByTestId('claude-oauth-slots')).toBeVisible()
		}
	})

	test('PATCH /api/workspaces rejects a BYO key add for a non-entitled workspace', async ({
		account,
	}) => {
		const res = await fetch(`${BASE}/api/workspaces/${account.workspaceId}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${account.apiKey}`,
			},
			body: JSON.stringify({ settings: { llm_keys: { anthropic: 'sk-ant-blocked' } } }),
		})
		expect(res.status).toBe(403)
	})
})
