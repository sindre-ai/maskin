import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loop detail page when its calls fail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`says what failed, per block, with Try again at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Slow loop',
				status: 'learning',
				content: 'Every slow request gets an answer',
			})

			// A 4xx is not retried, so the failure shows at once. The 30 s give-up on a call that
			// never answers is covered by the unit test (fake timers).
			let failing = true
			await page.route('**/api/loops/*/activity', (route) =>
				failing
					? route.fulfill({
							status: 400,
							contentType: 'application/json',
							body: JSON.stringify({ error: { message: 'Busy' } }),
						})
					: route.continue(),
			)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			await expect(page.getByRole('heading', { name: 'Slow loop' }).first()).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByText(/Couldn't load the loop's recent activity/)).toBeVisible()
			// The other blocks still render.
			await expect(page.getByTestId('loop-stats')).toBeVisible()
			await expect(page.getByTestId('loop-block-error')).toHaveCount(1)

			failing = false
			await page.getByRole('button', { name: 'Try again' }).click()
			await expect(page.getByTestId('loop-block-error')).toHaveCount(0)
		})
	}
})

test.describe('Loops list display setting', () => {
	test('a person with no saved setting makes no failing request', async ({ page, account }) => {
		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Fresh loop',
			status: 'learning',
		})
		const failed: string[] = []
		page.on('response', (res) => {
			if (res.url().includes('/api/user-display-settings/') && res.status() >= 400) {
				failed.push(`${res.status()} ${res.url()}`)
			}
		})

		const settled = page.waitForResponse((res) => res.url().includes('/user-display-settings/loop'))
		await page.goto(`/${account.workspaceId}/loops`)
		const res = await settled

		expect(res.status()).toBe(200)
		expect(failed).toEqual([])
	})
})
