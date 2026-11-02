import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — section headings with counts, the greeting, and "Mark all read".
 *
 * The curated list is mocked so the buckets are deterministic. Dismissals are
 * kept by the mock, so a reload proves the cleared Updates stay cleared.
 */

interface Seed {
	id: string
	title: string
	decision: boolean
}

const SEEDS: Seed[] = [
	{ id: 'decide-a', title: 'Merge the rewrite?', decision: true },
	{ id: 'decide-b', title: 'Finish the edit card, or cut it?', decision: true },
	{ id: 'update-a', title: 'The nightly import finished', decision: false },
	{ id: 'update-b', title: 'Two leads replied', decision: false },
	{ id: 'update-c', title: 'The report is ready', decision: false },
]

function curatedItem(workspaceId: string, seed: Seed, index: number) {
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
			decision: seed.decision
				? {
						title: seed.title,
						summary: 'Needs a call.',
						ask: 'Which way?',
						options: [
							{ label: 'Send back', consequences: ['Nothing ships'] },
							{ label: 'Merge now', recommended: true, consequences: ['Ships tonight'] },
						],
					}
				: null,
		},
	}
}

async function mockFeed(page: Page, workspaceId: string) {
	const dismissed = new Set<string>()
	await page.route('**/api/files**', (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
			: route.fallback(),
	)
	await page.route('**/api/for-you/dismissals', async (route) => {
		const body = route.request().postDataJSON() as { notification_id?: string }
		if (body.notification_id) dismissed.add(body.notification_id)
		await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
	})
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const items = SEEDS.map((seed, index) => curatedItem(workspaceId, seed, index)).filter(
			(item) => !dismissed.has(item.notification_id),
		)
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('For You sections', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`headings with counts, in order @ ${vp.label} ${scheme}`, async ({ page, account }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.emulateMedia({ colorScheme: scheme })
				await mockFeed(page, account.workspaceId)
				await page.goto(`/${account.workspaceId}`)

				const decide = page.getByRole('heading', { name: /^To decide\s*2$/ })
				const updates = page.getByRole('heading', { name: /^Updates for you\s*3$/ })
				await expect(decide).toBeVisible()
				await expect(updates).toBeVisible()
				const decideBox = await decide.boundingBox()
				const updatesBox = await updates.boundingBox()
				expect(decideBox?.y ?? 0).toBeLessThan(updatesBox?.y ?? 0)

				// Empty buckets draw no heading.
				await expect(page.getByRole('heading', { name: /Waiting on an agent/ })).toHaveCount(0)
				await expect(page.getByRole('heading', { name: /Handled today/ })).toHaveCount(0)

				// The greeting is the page title; the lead line sits under it.
				await expect(page.getByRole('heading', { level: 1 })).toContainText(
					/^Good (night|morning|afternoon|evening)/,
				)
				await expect(page.getByTestId('foryou-greeting')).toContainText(
					'2 decisions are waiting on you',
				)
				await assertNoHorizontalOverflow(page, vp.label)
			})
		}
	}

	test('Mark all read clears Updates and survives a reload', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByRole('heading', { name: /^Updates for you\s*3$/ })).toBeVisible()
		await page.getByRole('button', { name: 'Mark all read' }).click()
		await expect(page.getByRole('heading', { name: /Updates for you/ })).toHaveCount(0)
		await expect(page.getByRole('heading', { name: /^To decide\s*2$/ })).toBeVisible()

		await page.reload()
		await expect(page.getByRole('heading', { name: /^To decide\s*2$/ })).toBeVisible()
		await expect(page.getByRole('heading', { name: /Updates for you/ })).toHaveCount(0)
	})
})
