import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

async function importClaudeOAuth(
	apiKey: string,
	workspaceId: string,
	tokens: {
		accessToken: string
		refreshToken: string
		expiresAt: number
		subscriptionType?: string
		slot?: 'primary' | 'backup'
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

async function getWorkspaceSettings(apiKey: string, workspaceId: string) {
	const res = await fetch(`${BASE}/api/workspaces`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	const list = (await res.json()) as Array<{ id: string; settings: Record<string, unknown> }>
	const ws = list.find((w) => w.id === workspaceId)
	if (!ws) throw new Error(`Workspace ${workspaceId} not found`)
	return ws.settings
}

// Workspaces default to byollmAllowed: false — the platform-provided LLM plan.
// These specs exercise the Claude OAuth UI directly, so grant entitlement
// first (mirrors an ops-flagged exception workspace). See PR #970.
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

const seedPrimary = {
	accessToken: 'e2e-primary-access',
	refreshToken: 'e2e-primary-refresh',
	expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
	subscriptionType: 'max-5x',
}

// An already-failed-over state (both slots connected, active_slot flipped to
// backup with a specific classified reason + timestamp) is only ever
// produced by a live session-start failover (apps/dev/src/lib/claude-failover.ts)
// under a row lock — there's no write path a test can seed it through
// directly. PATCH /api/workspaces/:id intentionally rejects `claude_oauth`
// (apps/dev/src/routes/workspaces.ts) so an unlocked merge can't clobber that
// locked state. Mock the status boundary instead, same pattern as
// foryou-sparse-composer.spec.ts's `mockUnreadCount`.
async function mockFailedOverStatus(page: Page) {
	const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
	await page.route('**/api/claude-oauth/status*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				connected: true,
				valid: true,
				subscription_type: 'pro',
				expires_at: expiresAt,
				slots: {
					primary: { subscription_type: 'max-5x', expires_at: expiresAt, fingerprint: 'e2eprim1' },
					backup: { subscription_type: 'pro', expires_at: expiresAt, fingerprint: 'e2ebckp1' },
				},
				active_slot: 'backup',
				last_primary_failure_at: Date.now() - 2 * 60 * 1000,
				last_classified_reason: 'quota_exhausted_weekly',
			}),
		})
	})
}

test.describe('Claude subscription failover — settings UI', () => {
	test('AC-U3: surfaces failover banner, classified reason, and Unhealthy primary when failed over', async ({
		page,
		account,
	}) => {
		await grantByollmAllowed(account.apiKey, account.workspaceId)
		await mockFailedOverStatus(page)

		await page.goto(`/${account.workspaceId}/settings/keys`)

		// The banner is the customer's signal that something happened.
		const banner = page.getByTestId('failover-banner')
		await expect(banner).toBeVisible()
		await expect(banner).toContainText('Running on backup')
		await expect(banner).toContainText('weekly usage limit')

		// Primary card shows Unhealthy + reason line (T3 copy)
		const primary = page.getByTestId('slot-primary')
		await expect(primary).toContainText('Unhealthy')
		await expect(primary).toContainText('Weekly usage limit reached')

		// Backup is the active slot — In use chip lives there
		const backup = page.getByTestId('slot-backup')
		await expect(backup).toContainText('In use')
		await expect(primary).not.toContainText('In use')

		// Ship-gate viewports — surface must be reachable on each
		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(page.getByTestId('failover-banner')).toBeVisible()
			await expect(page.getByTestId('slot-primary')).toBeVisible()
			await expect(page.getByTestId('slot-backup')).toBeVisible()
		}
	})

	test('AC-U5: backup designation persists across reload', async ({ page, account }) => {
		await grantByollmAllowed(account.apiKey, account.workspaceId)
		// Seed a primary so the "Add a backup" CTA renders. The slot field on the
		// import body is what the customer designation flows through.
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)

		// Sanity: backup is empty
		const backup = page.getByTestId('slot-backup')
		await expect(backup).toContainText('Add a backup')

		// Open the paste flow from the empty backup card
		await page.getByRole('button', { name: 'Import backup credentials' }).click()
		const pasteFlow = page.getByTestId('paste-flow')
		await expect(pasteFlow).toBeVisible()

		// Backup radio should be pre-selected
		await expect(page.getByRole('radio', { name: /Backup/ })).toHaveAttribute(
			'aria-checked',
			'true',
		)

		await page.getByPlaceholder(/Paste the contents/).fill(
			JSON.stringify({
				claudeAiOauth: {
					accessToken: 'e2e-paste-access',
					refreshToken: 'e2e-paste-refresh',
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
					subscriptionType: 'pro',
				},
			}),
		)
		// Scoped to the paste flow — "Import backup credentials" (the button that
		// opened this flow) stays mounted underneath and also matches the broad
		// 'Import' substring, so an unscoped locator resolves to two elements.
		await pasteFlow.getByRole('button', { name: 'Import' }).click()

		// Backup slot should now render in connected state with a Disconnect action.
		// SlotCard renders "Connected" for a healthy slot ("Unhealthy" only when
		// a failover reason line is present) — see keys.tsx's `isUnhealthy` check.
		await expect(backup).toContainText('Connected', { timeout: 10_000 })

		// AC-U5: reload — designation persists
		await page.reload()
		await expect(page.getByTestId('slot-primary')).toContainText('Connected')
		await expect(page.getByTestId('slot-backup')).toContainText('Connected')

		// And the storage shape on disk has the backup slot populated (not the
		// primary key being overwritten with the just-pasted tokens).
		const settings = (await getWorkspaceSettings(account.apiKey, account.workspaceId)) as {
			claude_oauth?: { primary?: unknown; backup?: { encryptedAccessToken: string } }
		}
		expect(settings.claude_oauth?.primary).toBeDefined()
		expect(settings.claude_oauth?.backup).toBeDefined()
	})
})
