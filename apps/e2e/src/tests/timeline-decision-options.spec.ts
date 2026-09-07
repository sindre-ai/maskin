import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * A decision is answerable on the object timeline, not only in For You.
 *
 * The timeline marks a decision comment as needing the reader, so it has to
 * offer the options too — badging a call and then sending the reader to another
 * surface to make it is the state this replaced. Taking an option posts the
 * label as a reply threaded under the ask.
 */

const DECISION = {
	title: 'Ship the retry backoff?',
	summary: '3 sessions stalled last night. The patch is written and tested.',
	ask: 'This changes what every running session does, so I will not ship it alone.',
	options: [
		{ label: 'Hold', consequences: ['Nothing ships this cycle', 'Stalls keep happening'] },
		{
			label: 'Ship',
			recommended: true,
			consequences: ['Goes out tonight', 'Leaves no rollback'],
		},
	],
}

test.describe('Object timeline — decision options', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders and answers a decision at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Retry backoff',
				status: 'active',
			})
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: 'The backoff patch is ready for a call.',
				decision: DECISION,
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			// The ask and both options are on the page, at every viewport. Buttons
			// rather than text: the reader answers here.
			const ship = page.getByRole('button', { name: /Ship/ })
			await expect(ship).toBeVisible({ timeout: 15000 })
			await expect(page.getByRole('button', { name: /Hold/ })).toBeVisible()
			await expect(page.getByText(DECISION.ask)).toBeVisible()
			// The consequences are what make an option a choice rather than a label.
			await expect(page.getByText('Leaves no rollback')).toBeVisible()

			// A full-width options grid on a narrow screen is the likely overflow,
			// so check it at the viewport that would show it.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)

			await ship.click()

			// The answer posts as a real comment and the question reads as settled.
			await expect(page.getByText('Answered:')).toBeVisible({ timeout: 15000 })
			await expect(page.getByRole('button', { name: /Hold/ })).toHaveCount(0)

			// It survives a reload, which proves the reply was persisted rather
			// than only reflected in local state.
			await page.reload()
			await expect(page.getByText('Answered:')).toBeVisible({ timeout: 15000 })
		})
	}

	test('the recommended option is legible in both colour schemes', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Retry backoff colour',
			status: 'active',
		})
		await account.api.createComment(account.workspaceId, {
			entity_id: bet.id,
			content: 'The backoff patch is ready for a call.',
			decision: DECISION,
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		// The recommended option is the filled bar. `bg-primary` is the token that
		// reads in both schemes; `bg-accent` would vanish on white.
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await expect(page.getByRole('button', { name: /Ship/ })).toBeVisible({ timeout: 15000 })
			await expect(page.getByText('Goes out tonight')).toBeVisible()
		}
	})
})
