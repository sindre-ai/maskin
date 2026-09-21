import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { grantEnterprise } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

// The keys page re-runs the auth guard, the feature-flag load, and the
// workspace + oauth-status queries after a reload. On a loaded CI runner that
// pipeline routinely runs past Playwright's 5s default for `toHaveValue`, so
// wait for the slot card to actually mount first — the value check that
// follows then stays strict.
async function waitForPrimarySlot(page: Page) {
	await expect(page.getByTestId('slot-primary')).toBeVisible({ timeout: 30_000 })
}

async function importClaudeOAuth(
	apiKey: string,
	workspaceId: string,
	tokens: {
		accessToken: string
		refreshToken: string
		expiresAt: number
		subscriptionType?: string
		slot?: 'primary' | 'backup'
		nickname?: string
	},
) {
	const res = await fetch(`${BASE}/api/claude-oauth/import`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
		},
		body: JSON.stringify(tokens),
	})
	if (!res.ok) {
		throw new Error(`Claude OAuth import failed: ${res.status} ${await res.text()}`)
	}
	return res.json()
}

const seedPrimary = {
	accessToken: 'e2e-nickname-primary-access',
	refreshToken: 'e2e-nickname-primary-refresh',
	expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
	subscriptionType: 'max-5x',
}

test.describe('Claude subscription nickname — settings UI', () => {
	// These specs seed a slot over the API, drive the nickname input and reload
	// the settings page — more steps than Playwright's 30s default test timeout
	// comfortably covers on a loaded CI runner, and the reload wait below needs
	// room to actually elapse rather than starving the budget.
	test.describe.configure({ timeout: 60_000 })

	test('typing a nickname into a connected slot persists it across reload', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await waitForPrimarySlot(page)

		const primary = page.getByTestId('slot-primary')
		await expect(primary).toContainText('Connected')

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		// The rename mutation fires on blur but does not await inside the
		// handler, so waiting for the PATCH response is the only way to know
		// the server has the new value before we reload. The input already
		// holds "Work account" from the fill() above, so a `toHaveValue`
		// assertion here would pass locally before the mutation had reached
		// the server and gave nothing to observe.
		const rename = page.waitForResponse(
			(res) =>
				res.url().includes('/api/claude-oauth/nickname') && res.request().method() === 'PATCH',
		)
		await nicknameInput.fill('Work account')
		await nicknameInput.blur()
		await rename

		await page.reload()
		await waitForPrimarySlot(page)
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Work account')

		// Ship-gate viewports — the editable nickname must be reachable on each,
		// and the saved value must still be rendered on the slot (not just the
		// empty input visible).
		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const nicknameInput = page.getByTestId('slot-primary-nickname')
			await expect(nicknameInput).toBeVisible()
			await expect(nicknameInput).toHaveValue('Work account')
		}
	})

	test('a long nickname renders on the slot at all ship-gate viewports', async ({
		page,
		account,
	}) => {
		// Long labels are the case most likely to clip or scroll out of view on
		// narrow widths — the reported "nickname missing on small screens".
		const longNickname = 'The primary work account nickname for Q3'
		await grantEnterprise(account.apiKey, account.workspaceId)
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
			nickname: longNickname,
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await waitForPrimarySlot(page)

		// Wait for the slot to finish loading before asserting on its nickname
		// input, the same way the "typing a nickname" test above does — without
		// this, the input isn't in the DOM yet and the locator times out.
		await expect(page.getByTestId('slot-primary')).toContainText('Connected')

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		await expect(nicknameInput).toHaveValue(longNickname)

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(nicknameInput).toBeVisible()
			await expect(nicknameInput).toHaveValue(longNickname)
		}
	})

	test('clearing a nickname reverts to the placeholder', async ({ page, account }) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
			nickname: 'Old label',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await waitForPrimarySlot(page)

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		await expect(nicknameInput).toHaveValue('Old label')

		// The rename mutation fires on blur but does not await inside the
		// handler — wait for the PATCH so the server has the cleared value
		// before we reload. See the reasoning on the "typing a nickname" test
		// above.
		const rename = page.waitForResponse(
			(res) =>
				res.url().includes('/api/claude-oauth/nickname') && res.request().method() === 'PATCH',
		)
		await nicknameInput.fill('')
		await nicknameInput.blur()
		await rename

		await page.reload()
		await waitForPrimarySlot(page)
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('')
		await expect(page.getByTestId('slot-primary-nickname')).toHaveAttribute(
			'placeholder',
			'Add a nickname',
		)
	})
})
