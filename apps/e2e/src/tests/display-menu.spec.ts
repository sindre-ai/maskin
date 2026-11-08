import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * One Display menu everywhere. Each of Items, Flows, Agents and For you opens
 * the same panel from a "Display" control; For you carries View (Cards | List)
 * and Show, and its choices persist across a reload.
 */

const SEEDS = [
	{ id: 'decide-a', title: 'Merge the rewrite?', type: 'bet' },
	{ id: 'update-a', title: 'The nightly import finished', type: 'insight' },
]

function curatedItem(workspaceId: string, seed: (typeof SEEDS)[number], index: number) {
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
			type: seed.type,
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
			decision: null,
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

async function openDisplay(page: Page) {
	await page.getByRole('button', { name: /^Display/ }).click()
	const panel = page.getByRole('dialog')
	await expect(panel).toBeVisible()
	return panel
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('Display menu', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`For you: View and Show, persisted @ ${vp.label} ${scheme}`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.emulateMedia({ colorScheme: scheme })
				await mockFeed(page, account.workspaceId)
				await page.goto(`/${account.workspaceId}`)
				await expect(page.getByTestId('foryou-greeting')).toBeVisible()

				// The menu sits in the title row, beside the page title.
				const panel = await openDisplay(page)
				await expect(panel.getByText('Show', { exact: true })).toBeVisible()
				await expect(panel.getByRole('button', { name: /View: Cards/ })).toHaveAttribute(
					'aria-pressed',
					'true',
				)
				// Show lists the card kinds with counts, open by default.
				await expect(panel.getByRole('button', { name: /^Everything/ })).toBeVisible()
				await expect(panel.getByRole('button', { name: /^Decisions/ })).toBeVisible()

				// Narrowing to Decisions puts a count on the trigger and offers Reset filters.
				await panel.getByRole('button', { name: /^Decisions/ }).click()
				await expect(panel.getByRole('button', { name: 'Reset filters' })).toBeVisible()
				await panel.getByRole('button', { name: 'Reset filters' }).click()
				await expect(panel.getByRole('button', { name: 'Reset filters' })).toHaveCount(0)

				// List persists across a reload.
				const saved = page.waitForResponse(
					(r) =>
						r.url().includes('/user-display-settings/__chrome__') && r.request().method() === 'PUT',
				)
				await panel.getByRole('button', { name: /View: List/ }).click()
				await saved
				await page.reload()
				await expect(page.getByTestId('foryou-greeting')).toBeVisible()
				const again = await openDisplay(page)
				await expect(again.getByRole('button', { name: /View: List/ })).toHaveAttribute(
					'aria-pressed',
					'true',
				)

				// Reset display restores Cards.
				const reset = page.waitForResponse(
					(r) =>
						r.url().includes('/user-display-settings/__chrome__') && r.request().method() === 'PUT',
				)
				await again.getByText('Reset display').click()
				await reset
				await expect(again.getByRole('button', { name: /View: Cards/ })).toHaveAttribute(
					'aria-pressed',
					'true',
				)
				await assertNoHorizontalOverflow(page, vp.label)
			})

			test(`Items, Flows and Agents open the same panel @ ${vp.label} ${scheme}`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.emulateMedia({ colorScheme: scheme })
				await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: 'Display Menu Probe',
					status: 'opportunity',
				})

				await page.goto(`/${account.workspaceId}/objects`)
				await expect(page.getByText('Display Menu Probe')).toBeVisible({ timeout: 10_000 })
				let panel = await openDisplay(page)
				await expect(panel.getByText('Ordering')).toBeVisible()
				await page.keyboard.press('Escape')

				await page.goto(`/${account.workspaceId}/loops`)
				panel = await openDisplay(page)
				await expect(panel.getByText('Ordering')).toBeVisible()
				await page.keyboard.press('Escape')

				await page.goto(`/${account.workspaceId}/agents`)
				panel = await openDisplay(page)
				await expect(panel.getByText('Reset display')).toBeVisible()
				await assertNoHorizontalOverflow(page, vp.label)
			})
		}
	}
})
