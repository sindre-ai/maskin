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
	test('typing a nickname into a connected slot persists it across reload', async ({
		page,
		account,
	}) => {
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)

		const primary = page.getByTestId('slot-primary')
		await expect(primary).toContainText('Connected')

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		await nicknameInput.fill('Work account')
		await nicknameInput.blur()

		// The card re-renders with the saved nickname once the mutation settles.
		await expect(nicknameInput).toHaveValue('Work account', { timeout: 10_000 })

		await page.reload()
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
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
			nickname: longNickname,
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		await expect(nicknameInput).toHaveValue(longNickname)

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(nicknameInput).toBeVisible()
			await expect(nicknameInput).toHaveValue(longNickname)
		}
	})

	test('clearing a nickname reverts to the placeholder', async ({ page, account }) => {
		await importClaudeOAuth(account.apiKey, account.workspaceId, {
			...seedPrimary,
			slot: 'primary',
			nickname: 'Old label',
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)

		const nicknameInput = page.getByTestId('slot-primary-nickname')
		await expect(nicknameInput).toHaveValue('Old label')

		await nicknameInput.fill('')
		await nicknameInput.blur()
		await expect(nicknameInput).toHaveValue('', { timeout: 10_000 })

		await page.reload()
		await expect(page.getByTestId('slot-primary-nickname')).toHaveValue('')
		await expect(page.getByTestId('slot-primary-nickname')).toHaveAttribute(
			'placeholder',
			'Add a nickname',
		)
	})
})
