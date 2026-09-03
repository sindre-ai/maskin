import { expect, test } from '../fixtures/auth.fixture'
import { grantEnterprise } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

/**
 * A workspace can connect more than the original two Claude subscriptions:
 * sessions walk the list top to bottom, so what the settings page has to get
 * right is the ORDER — which one is used first, and how a customer changes it.
 */
async function importClaudeOAuth(
	apiKey: string,
	workspaceId: string,
	body: {
		accessToken: string
		refreshToken: string
		expiresAt: number
		subscriptionType?: string
		slot?: string
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
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		throw new Error(`Claude OAuth import failed: ${res.status} ${await res.text()}`)
	}
	return res.json() as Promise<{ slot: string }>
}

function credentials(suffix: string) {
	return {
		accessToken: `e2e-${suffix}-access`,
		refreshToken: `e2e-${suffix}-refresh`,
		expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
		subscriptionType: 'pro',
	}
}

async function seedChain(apiKey: string, workspaceId: string, count: number) {
	for (let i = 0; i < count; i++) {
		await importClaudeOAuth(apiKey, workspaceId, {
			...credentials(`chain-${i}`),
			slot: 'new',
			nickname: `Account ${i + 1}`,
		})
	}
}

test.describe('Claude subscriptions — more than two', () => {
	test('a third subscription can be added and renders as a fallback at every ship-gate viewport', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await seedChain(account.apiKey, account.workspaceId, 2)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await expect(page.getByTestId('slot-primary')).toContainText('Connected')

		await page.getByRole('button', { name: 'Import another subscription' }).click()
		const pasteFlow = page.getByTestId('paste-flow')
		await expect(pasteFlow).toBeVisible()
		await expect(page.getByRole('radio', { name: 'Add as Fallback 3' })).toHaveAttribute(
			'aria-checked',
			'true',
		)

		await page.getByPlaceholder(/Paste the contents/).fill(
			JSON.stringify({
				claudeAiOauth: {
					accessToken: 'e2e-third-access',
					refreshToken: 'e2e-third-refresh',
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
					subscriptionType: 'pro',
				},
			}),
		)
		await pasteFlow.getByRole('button', { name: 'Import' }).click()

		const third = page.getByTestId('slot-slot_3')
		await expect(third).toContainText('Connected', { timeout: 10_000 })
		await expect(third).toContainText('Fallback 3')

		// Survives a reload — it is stored, not just rendered.
		await page.reload()
		await expect(page.getByTestId('slot-slot_3')).toContainText('Connected')

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(page.getByTestId('slot-primary')).toBeVisible()
			await expect(page.getByTestId('slot-backup')).toBeVisible()
			await expect(page.getByTestId('slot-slot_3')).toBeVisible()
		}
	})

	test('"Use first" moves a fallback to the front of the list and the order persists', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await seedChain(account.apiKey, account.workspaceId, 3)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		// Nicknames travel with the credential, so they are how we can see that
		// the third subscription really moved to the front.
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 1')
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 3')

		await page
			.getByTestId('slot-slot_3')
			.getByRole('button', { name: /Use first/ })
			.click()

		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 3', {
			timeout: 10_000,
		})
		await expect(page.getByTestId('slot-primary')).toContainText('In use')

		await page.reload()
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 3')
		await expect(page.getByTestId('slot-backup-nickname')).toHaveValue('Account 1')
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 2')
	})

	test('disconnecting one subscription leaves the rest connected and re-labelled by position', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await seedChain(account.apiKey, account.workspaceId, 3)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await expect(page.getByTestId('slot-backup')).toContainText('Connected')

		await page
			.getByTestId('slot-backup')
			.getByRole('button', { name: /Disconnect/ })
			.click()

		await expect(page.getByTestId('slot-backup')).toBeHidden({ timeout: 10_000 })
		// The survivor keeps its id but is now the second one tried, so it is
		// labelled Backup.
		await expect(page.getByTestId('slot-slot_3')).toContainText('Backup')
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 3')

		await page.reload()
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 1')
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 3')
	})

	test('a nickname set at import time is shown and can be changed on any subscription', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await seedChain(account.apiKey, account.workspaceId, 3)

		await page.goto(`/${account.workspaceId}/settings/keys`)

		const nickname = page.getByTestId('slot-slot_3-nickname')
		await expect(nickname).toHaveValue('Account 3')
		await nickname.fill('Spare account')
		await nickname.blur()

		await page.reload()
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Spare account')
	})
})
