import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — "Later": a browser-only reminder on a decision card (v16). The card steps
 * out of Decisions into a "Later" group, can be brought back, and survives a reload.
 * Nothing is written to the server, so the mock accepts no write at all.
 */

const SEEDS = [
	{ id: 'decide-a', title: 'Merge the rewrite?' },
	{ id: 'decide-b', title: 'Finish the edit card, or cut it?' },
]

function curatedItem(workspaceId: string, seed: { id: string; title: string }, index: number) {
	const at = new Date(Date.now() - (index + 1) * 3_600_000).toISOString()
	return {
		notification_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		rank: index + 1,
		headline: seed.title,
		rationale: null,
		created_at: at,
		entity_type: 'object' as const,
		entity_id: seed.id,
		session_id: null,
		object: {
			id: seed.id,
			title: `${seed.title} (item)`,
			type: 'task',
			status: 'in_review',
			content: '',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 40 + index,
			actor_id: null,
			created_at: at,
			content: seed.title,
			attention: 3,
			decision: {
				title: seed.title,
				summary: 'Needs a call.',
				ask: 'Which way?',
				options: [
					{ label: 'Send back', consequences: ['Nothing ships'] },
					{ label: 'Merge now', recommended: true, consequences: ['Ships tonight'] },
				],
			},
		},
	}
}

async function mockFeed(page: Page, workspaceId: string) {
	await page.route('**/api/files**', (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
			: route.fallback(),
	)
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: SEEDS.map((seed, index) => curatedItem(workspaceId, seed, index)),
			}),
		})
	})
}

test.describe('For You — Later', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`set aside, reload, bring back @ ${vp.label} ${scheme}`, async ({ page, account }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.emulateMedia({ colorScheme: scheme })
				await mockFeed(page, account.workspaceId)
				// Stale ids from an earlier visit must be ignored without a trace.
				await page.addInitScript(
					([ws]) => {
						if (localStorage.getItem('maskin:foryou-later:v1')) return
						const later = { label: 'Tomorrow, 08:00', eventId: 1 }
						localStorage.setItem(
							'maskin:foryou-later:v1',
							JSON.stringify({
								[`${ws}|object:gone`]: { ...later, until: Date.now() + 86_400_000 },
								[`${ws}|object:old`]: { ...later, until: Date.now() - 1000 },
							}),
						)
					},
					[account.workspaceId],
				)
				await page.goto(`/${account.workspaceId}`)

				await expect(page.getByRole('heading', { name: /^Decisions\s*2$/ })).toBeVisible()
				await expect(page.getByRole('heading', { name: /^Later/ })).toHaveCount(0)

				await page.getByRole('button', { name: 'Later', exact: true }).first().click()
				await expect(page.getByText('Only you are reminded. This browser only.')).toBeVisible()
				await page.getByRole('menuitem', { name: 'Tomorrow, 08:00' }).click()

				await expect(page.getByRole('heading', { name: /^Decisions\s*1$/ })).toBeVisible()
				await expect(page.getByRole('heading', { name: /^Later\s*1$/ })).toBeVisible()
				const row = page.getByTestId('foryou-later-row')
				await expect(row).toContainText(SEEDS[0]?.title ?? '')
				await expect(row).toContainText(
					'Later · back tomorrow, 08:00 · only you are reminded, this browser only',
				)
				await expect(page.getByText('Back tomorrow, 08:00. Only you are reminded.')).toBeVisible()

				// Later sits below Decisions, and nothing spills sideways.
				const decisions = await page.getByRole('heading', { name: /^Decisions/ }).boundingBox()
				const later = await page.getByRole('heading', { name: /^Later/ }).boundingBox()
				expect(decisions?.y ?? 0).toBeLessThan(later?.y ?? 0)
				const { scrollWidth, innerWidth } = await page.evaluate(() => ({
					scrollWidth: document.documentElement.scrollWidth,
					innerWidth: window.innerWidth,
				}))
				expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1)

				await page.reload()
				await expect(page.getByRole('heading', { name: /^Later\s*1$/ })).toBeVisible()
				await expect(page.getByRole('heading', { name: /^Decisions\s*1$/ })).toBeVisible()

				await page.getByTestId('foryou-later-row').click()
				await expect(page.getByRole('heading', { name: /^Decisions\s*2$/ })).toBeVisible()
				await expect(page.getByRole('heading', { name: /^Later/ })).toHaveCount(0)
			})
		}
	}

	test('Undo on the toast puts the card straight back', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await page.getByRole('button', { name: 'Later', exact: true }).first().click()
		await page.getByRole('menuitem', { name: 'Tomorrow, 08:00' }).click()
		await expect(page.getByRole('heading', { name: /^Later\s*1$/ })).toBeVisible()

		await page.getByRole('button', { name: 'Undo' }).click()
		await expect(page.getByRole('heading', { name: /^Decisions\s*2$/ })).toBeVisible()
		await expect(page.getByRole('heading', { name: /^Later/ })).toHaveCount(0)
	})
})
