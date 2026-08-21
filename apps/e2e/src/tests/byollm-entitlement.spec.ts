import { expect, test } from '../fixtures/auth.fixture'
import { grantByollmAllowed } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

test.describe('BYOLLM entitlement gate — settings UI', () => {
	test('hides BYO controls for a non-entitled workspace', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/settings/keys`)

		await expect(page.getByTestId('byollm-disabled-notice')).toHaveCount(0)
		await expect(page.getByTestId('claude-oauth-slots')).toHaveCount(0)
		await expect(page.getByText('LLM API Keys')).toHaveCount(0)
		await expect(page.getByText('Custom Model Endpoint (beta)')).toHaveCount(0)

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(page.getByTestId('claude-oauth-slots')).toHaveCount(0)
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
