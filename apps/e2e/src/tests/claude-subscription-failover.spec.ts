import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

async function patchWorkspaceSettings(
	apiKey: string,
	workspaceId: string,
	settings: Record<string, unknown>,
) {
	const res = await fetch(`${BASE}/api/workspaces/${workspaceId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ settings }),
	})
	if (!res.ok) {
		throw new Error(`PATCH workspace failed: ${res.status} ${await res.text()}`)
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

const seedPrimary = {
	encryptedAccessToken: 'e2e-primary-access',
	encryptedRefreshToken: 'e2e-primary-refresh',
	expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
	subscriptionType: 'max-5x',
}

const seedBackup = {
	encryptedAccessToken: 'e2e-backup-access',
	encryptedRefreshToken: 'e2e-backup-refresh',
	expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
	subscriptionType: 'pro',
}

test.describe('Claude subscription failover — settings UI', () => {
	test('AC-U3: surfaces failover banner, classified reason, and Unhealthy primary when failed over', async ({
		page,
		account,
	}) => {
		await patchWorkspaceSettings(account.apiKey, account.workspaceId, {
			claude_oauth: {
				primary: seedPrimary,
				backup: seedBackup,
				failover: {
					active_slot: 'backup',
					last_classified_reason: 'quota_exhausted_weekly',
					last_primary_failure_at: Date.now() - 2 * 60 * 1000,
				},
			},
		})

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
		// Seed a primary so the "Add a backup" CTA renders. The slot field on the
		// import body is what the customer designation flows through.
		await patchWorkspaceSettings(account.apiKey, account.workspaceId, {
			claude_oauth: { primary: seedPrimary },
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
		await page.getByRole('button', { name: 'Import' }).click()

		// Backup slot should now render in connected state with a Disconnect action.
		await expect(backup).toContainText('Healthy', { timeout: 10_000 })

		// AC-U5: reload — designation persists
		await page.reload()
		await expect(page.getByTestId('slot-primary')).toContainText('Healthy')
		await expect(page.getByTestId('slot-backup')).toContainText('Healthy')

		// And the storage shape on disk has the backup slot populated (not the
		// primary key being overwritten with the just-pasted tokens).
		const settings = (await getWorkspaceSettings(account.apiKey, account.workspaceId)) as {
			claude_oauth?: { primary?: unknown; backup?: { encryptedAccessToken: string } }
		}
		expect(settings.claude_oauth?.primary).toBeDefined()
		expect(settings.claude_oauth?.backup).toBeDefined()
	})
})
