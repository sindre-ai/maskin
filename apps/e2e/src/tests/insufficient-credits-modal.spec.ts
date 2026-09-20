import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The pre-session credit gate (apps/dev) answers HTTP 402 with an
 * INSUFFICIENT_CREDITS envelope when a workspace's prepaid balance is at or
 * below the reserve. Every frontend surface that starts a session must catch
 * that code and render the one shared InsufficientCreditsModal instead of a
 * toast or a generic failure.
 *
 * CI cannot drive a real drain-to-zero: the server-side gate is off unless
 * FF_TESTER_FEATURES lists the flag and no TestAPI helper can set a balance.
 * So the 402 is produced by intercepting POST /api/sessions — the same request
 * the composer makes — and the visual layer is driven by the test-only
 * localStorage override for `maskin-credit-ux`.
 */

const CREDIT_UX_FLAG = 'maskin-credit-ux'

const INSUFFICIENT_CREDITS_BODY = JSON.stringify({
	error: {
		code: 'INSUFFICIENT_CREDITS',
		message: 'Workspace balance is below the minimum reserve',
		balance_cents: 42,
		min_reserve_cents: 50,
		topup_url: '/billing/credits',
	},
})

interface AnalyticsPayload {
	name: string
	workspace_id?: string
	balance_cents?: number
}

function collectAnalytics(page: import('@playwright/test').Page): AnalyticsPayload[] {
	const calls: AnalyticsPayload[] = []
	page.on('console', (msg) => {
		if (msg.type() !== 'info') return
		const args = msg.args()
		if (args.length < 2) return
		Promise.all(args.map((a) => a.jsonValue().catch(() => null)))
			.then((values) => {
				const [tag, payload] = values as [unknown, AnalyticsPayload | null]
				if (tag === '[analytics]' && payload && typeof payload === 'object') {
					calls.push(payload)
				}
			})
			.catch(() => {})
	})
	return calls
}

/** Intercept only the session-create POST; everything else falls through. */
async function interceptSessionCreateWith402(page: import('@playwright/test').Page) {
	await page.route('**/api/sessions', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.fallback()
			return
		}
		await route.fulfill({
			status: 402,
			contentType: 'application/json',
			body: INSUFFICIENT_CREDITS_BODY,
		})
	})
}

test.describe('InsufficientCreditsModal — out-of-credits session start', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`blocks the run and shows the modal @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Cass Credit Gate')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const analyticsCalls = collectAnalytics(page)

			// Test-only override: beats the fetched flag state, so the modal
			// boundary is on even though CI's backend has no tester features.
			// The theme key is seeded to 'system' because the app is class-based
			// and only follows prefers-color-scheme when the stored theme is
			// 'system' (apps/web/src/lib/theme.tsx) — without it emulateMedia
			// below would be inert and the dark pass would prove nothing.
			await page.addInitScript((flag: string) => {
				localStorage.setItem(`ff:${flag}`, 'on')
				localStorage.setItem('maskin-theme', 'system')
			}, CREDIT_UX_FLAG)

			await interceptSessionCreateWith402(page)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const composer = page.getByTestId('agent-composer')
			await expect(composer).toBeVisible({ timeout: 10_000 })
			const input = composer.getByLabel('Message Cass Credit Gate')
			await input.fill('Sweep the backlog before standup')
			await composer.getByRole('button', { name: 'Send message' }).click()

			const dialog = page.getByRole('dialog').filter({ hasText: 'Out of credits' })
			await expect(dialog).toBeVisible({ timeout: 10_000 })

			// Exact copy: title, interpolated balance, both CTAs.
			await expect(dialog.getByText('Out of credits', { exact: true })).toBeVisible()
			await expect(
				dialog.getByText(/Your workspace balance is \$0\.42\. Top up to run this agent\./),
			).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Top up credits' })).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible()

			// Dark-theme parity — the modal is reachable and legible in both modes.
			// The html class is asserted too, so a mode that never actually
			// applied fails here instead of passing on visibility alone.
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
			await expect(dialog.getByText('Out of credits', { exact: true })).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Top up credits' })).toBeVisible()

			await page.emulateMedia({ colorScheme: 'light' })
			await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/)
			await expect(dialog.getByText('Out of credits', { exact: true })).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Top up credits' })).toBeVisible()

			// The run is blocked: no success toast, draft preserved.
			await expect(page.getByText(/picked it up/)).toHaveCount(0)
			await expect(input).toHaveValue('Sweep the backlog before standup')

			// PostHog event fires on render. In CI posthog-js is uninitialised,
			// so trackEvent's console fallback is the observable contract.
			await page.waitForTimeout(200)
			const shown = analyticsCalls.filter((c) => c.name === 'credits_exhausted_error_shown')
			expect(shown).toHaveLength(1)
			expect(shown[0]).toMatchObject({
				name: 'credits_exhausted_error_shown',
				workspace_id: account.workspaceId,
				balance_cents: 42,
			})

			// Secondary CTA dismisses.
			await dialog.getByRole('button', { name: 'Close' }).click()
			await expect(dialog).toBeHidden()
		})
	}

	test('does not render when MASKIN_CREDIT_UX is off', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })

		const agent = await account.api.createAgentActor('Cass Credit Off')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await interceptSessionCreateWith402(page)
		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const composer = page.getByTestId('agent-composer')
		await expect(composer).toBeVisible({ timeout: 10_000 })
		await composer.getByLabel('Message Cass Credit Off').fill('Start anyway')
		await composer.getByRole('button', { name: 'Send message' }).click()

		// Flag off falls through to the composer's inline failed-send state.
		await expect(page.getByText(/your message is preserved/)).toBeVisible({ timeout: 10_000 })
		await expect(page.getByRole('dialog').filter({ hasText: 'Out of credits' })).toHaveCount(0)
	})

	test('primary CTA navigates to the billing settings surface', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Cass Credit Topup')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.addInitScript((flag: string) => {
			localStorage.setItem(`ff:${flag}`, 'on')
		}, CREDIT_UX_FLAG)

		await interceptSessionCreateWith402(page)
		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const composer = page.getByTestId('agent-composer')
		await expect(composer).toBeVisible({ timeout: 10_000 })
		await composer.getByLabel('Message Cass Credit Topup').fill('Top me up')
		await composer.getByRole('button', { name: 'Send message' }).click()

		const dialog = page.getByRole('dialog').filter({ hasText: 'Out of credits' })
		await expect(dialog).toBeVisible({ timeout: 10_000 })

		// The backend emits the relative '/billing/credits'; only an absolute
		// https:// target is followed, so a relative one lands on billing settings.
		await dialog.getByRole('button', { name: 'Top up credits' }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings/billing`))
		await expect(dialog).toBeHidden()
	})
})
