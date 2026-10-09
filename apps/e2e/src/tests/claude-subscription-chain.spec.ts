import type { Page } from '@playwright/test'
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

/**
 * A reload of the keys page re-runs the auth guard and the feature-flag load
 * before it even asks for subscription status, so the slot cards can take
 * longer than Playwright's 5s default to mount on a loaded CI runner. Every
 * flake this spec has produced was that wait expiring with no card rendered
 * yet ("element(s) not found"), never a wrong value — so wait for the first
 * card explicitly and let the assertions that follow stay strict.
 */
async function reloadKeysPage(page: Page) {
	await page.reload()
	// 30s rather than 15s: the same reload on a loaded CI runner has been
	// observed to take longer than that (shard 2 e2e wall-clock incidents,
	// PR #1633's verify-e2e run), and the timeout is what turned into a
	// flake-storm the shard couldn't recover from within its 15-min budget.
	await expect(page.getByTestId('slot-primary')).toBeVisible({ timeout: 30_000 })
}

test.describe('Claude subscriptions — nicknames', () => {
	// These tests seed subscriptions over the API, drive the paste flow and
	// reload the settings page — more steps than Playwright's 30s default test
	// timeout comfortably covers on a loaded CI runner, and the reload wait
	// above needs room to actually elapse rather than starving the budget.
	test.describe.configure({ timeout: 60_000 })

	test('a nickname survives replacing the credentials in that slot', async ({ page, account }) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...credentials('before'),
			nickname: 'Work account',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)
		// The auth guard, flag load and status query stack behind this goto —
		// on a loaded CI runner it can outlast toHaveValue's 5s default (see
		// reloadKeysPage above for the same reasoning).
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Work account', {
			timeout: 30_000,
		})

		// Replace the credentials the way someone would after a subscription's
		// tokens expire — the paste flow sends no nickname.
		await page.getByTestId('slot-primary').getByRole('button', { name: 'Replace' }).click()
		const pasteFlow = page.getByTestId('paste-flow')
		await pasteFlow.getByPlaceholder(/Paste the contents/).fill(
			JSON.stringify({
				claudeAiOauth: {
					accessToken: 'e2e-replaced-access',
					refreshToken: 'e2e-replaced-refresh',
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
					subscriptionType: 'pro',
				},
			}),
		)
		await pasteFlow.getByRole('button', { name: 'Import' }).click()

		await expect(page.getByTestId('paste-flow')).toBeHidden({ timeout: 10_000 })
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Work account')

		await reloadKeysPage(page)
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Work account')
	})
})

test.describe('Claude subscriptions — more than two', () => {
	test.describe.configure({ timeout: 60_000 })

	test('a third subscription can be added and renders as a fallback at every ship-gate viewport', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await seedChain(account.apiKey, account.workspaceId, 2)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		// The auth guard, flag load and status query stack behind this goto —
		// on a loaded CI runner it can outlast toContainText's 5s default (see
		// reloadKeysPage above for the same reasoning).
		await expect(page.getByTestId('slot-primary')).toContainText('Connected', {
			timeout: 30_000,
		})

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
		await reloadKeysPage(page)
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
		// the third subscription really moved to the front. The auth guard,
		// flag load and status query stack behind this goto — on a loaded CI
		// runner it can outlast toHaveValue's 5s default (see reloadKeysPage
		// above for the same reasoning).
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 1', {
			timeout: 30_000,
		})
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 3')

		await page
			.getByTestId('slot-slot_3')
			.getByRole('button', { name: /Use first/ })
			.click()

		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('Account 3', {
			timeout: 10_000,
		})
		await expect(page.getByTestId('slot-primary')).toContainText('In use')

		await reloadKeysPage(page)
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
		// The auth guard, flag load and status query stack behind this goto —
		// on a loaded CI runner it can outlast toContainText's 5s default (see
		// reloadKeysPage above for the same reasoning).
		await expect(page.getByTestId('slot-backup')).toContainText('Connected', {
			timeout: 30_000,
		})

		await page
			.getByTestId('slot-backup')
			.getByRole('button', { name: /Disconnect/ })
			.click()

		await expect(page.getByTestId('slot-backup')).toBeHidden({ timeout: 10_000 })
		// The survivor keeps its id but is now the second one tried, so it is
		// labelled Backup.
		await expect(page.getByTestId('slot-slot_3')).toContainText('Backup')
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Account 3')

		await reloadKeysPage(page)
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
		// The auth guard, flag load and status query stack behind the goto —
		// on a loaded CI runner it can outlast toHaveValue's 5s default (see
		// reloadKeysPage above for the same reasoning).
		await expect(nickname).toHaveValue('Account 3', { timeout: 30_000 })
		// Wait for the rename PATCH before reloading — the mutation fires on
		// blur but does not await inside the handler, so without this the
		// reload can race the server-side write.
		const rename = page.waitForResponse(
			(res) =>
				res.url().includes('/api/claude-oauth/nickname') && res.request().method() === 'PATCH',
		)
		await nickname.fill('Spare account')
		await nickname.blur()
		await rename

		await reloadKeysPage(page)
		await expect(page.getByTestId('slot-slot_3-nickname')).toHaveValue('Spare account')
	})
})
