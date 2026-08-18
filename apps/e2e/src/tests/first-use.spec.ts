import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * First use — what a brand-new workspace opens on.
 *
 * Unlike most For You specs, this one drives the **real seeded data**: creating
 * an account seeds the Chief of Staff's introduction and the marketplace
 * suggestions card (`apps/dev/src/services/first-use.ts`), so a fresh fixture
 * account already has a queue. Mocking `/subscriptions/unread` here would test
 * the renderer while leaving the thing that actually ships — the seed — unproven.
 *
 * The two cards the agents write (the researched Knowledge, and the first Bet)
 * are not asserted: they depend on a live agent session, so they are covered by
 * the integration tests around the seed + hand-off instead.
 */

async function openForYou(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}`)
	// `load` rather than `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires.
	await page.waitForLoadState('load')
	await expect(page.getByTestId('foryou-redesign-root')).toBeVisible({ timeout: 15000 })
}

function currentCard(page: Page) {
	return page.locator('[data-card-kind]')
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`First use @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('opens on the Chief of Staff introduction, not an empty queue', async ({
			page,
			account,
		}) => {
			await openForYou(page, account.workspaceId)

			// The introduction is scored above the suggestions card, so it leads.
			await expect(currentCard(page)).toHaveCount(1)
			await expect(page.getByText(/Welcome, /).first()).toBeVisible({ timeout: 15000 })
			await expect(page.getByText(/For you is a queue, not an inbox/).first()).toBeVisible()
		})

		test('explains a product surface in place when its chip is expanded', async ({
			page,
			account,
		}) => {
			await openForYou(page, account.workspaceId)

			const loopsChip = page.getByRole('button', { name: /^PAGE\s*Loops$/ })
			await expect(loopsChip).toBeVisible({ timeout: 15000 })
			await expect(loopsChip).toHaveAttribute('aria-expanded', 'false')

			// Collapsed: the explainer is absent, not merely hidden.
			await expect(page.getByText(/Work that runs without anyone starting it/)).toHaveCount(0)

			await loopsChip.click()
			await expect(loopsChip).toHaveAttribute('aria-expanded', 'true')
			await expect(page.getByText(/Work that runs without anyone starting it/)).toBeVisible()
			// And the reader can still leave for the real page from inside the card.
			await expect(page.getByText(/Open Loops/)).toBeVisible()
		})

		test('offers every product surface as its own chip', async ({ page, account }) => {
			await openForYou(page, account.workspaceId)
			for (const label of ['Chats', 'Loops', 'Objects', 'Marketplace']) {
				await expect(
					page.getByRole('button', { name: new RegExp(`^PAGE\\s*${label}$`) }),
				).toBeVisible({ timeout: 15000 })
			}
		})

		test('keeps the suggestions card behind the introduction, reachable by skipping', async ({
			page,
			account,
		}) => {
			await openForYou(page, account.workspaceId)
			await expect(page.getByText(/Welcome, /).first()).toBeVisible({ timeout: 15000 })

			// Mutation-free advance — the queue's "Keep unread" control.
			await page.getByRole('button', { name: 'Keep unread' }).click()

			await expect(page.getByText(/What are you hoping to get out of this\?/).first()).toBeVisible({
				timeout: 15000,
			})
			// The quick replies under the ask are real, tappable chips.
			await expect(page.getByRole('button', { name: 'Fewer things dropped' })).toBeVisible()
		})
	})
}

test.describe('First use — colour modes', () => {
	for (const colorScheme of ['light', 'dark'] as const) {
		test(`renders the introduction card legibly in ${colorScheme} mode`, async ({
			page,
			account,
		}) => {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), colorScheme)
			await page.emulateMedia({ colorScheme })
			await openForYou(page, account.workspaceId)

			await expect(page.getByText(/Welcome, /).first()).toBeVisible({ timeout: 15000 })

			const chip = page.getByRole('button', { name: /^PAGE\s*Loops$/ })
			await expect(chip).toBeVisible()

			// The chip is a bordered surface in both modes — the `bg-accent`
			// failure mode from .claude/rules/known-pitfalls.md is a chip that
			// renders with no visible boundary on white.
			const border = await chip.evaluate((el) => {
				const style = getComputedStyle(el.parentElement ?? el)
				return style.borderTopColor
			})
			expect(border).not.toBe('rgba(0, 0, 0, 0)')

			if (colorScheme === 'dark') {
				const isDark = await page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				)
				expect(isDark).toBe(true)
			}
		})
	}
})
