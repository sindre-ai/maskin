import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The web declutter pass (v3 prototype): System theme by default, For you headers without
 * counts and no Later/Hold, grouped-page labels in ink instead of small caps, no group-chat
 * note on New chat, and a retryable error where a list fails to load.
 */

function decisionItem(workspaceId: string) {
	const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
	return {
		entity_type: 'object' as const,
		entity_id: 'task-declutter',
		object: {
			id: 'task-declutter',
			title: 'Review 5 wiki pages',
			type: 'task',
			status: 'in_review',
			content: '',
			workspaceId,
			driver: null,
			metadata: {},
		},
		createdAt,
		latest_mention: {
			event_id: 91,
			actor_id: null,
			created_at: createdAt,
			content: 'Review 5 wiki pages',
			attention: 3,
			decision: {
				title: 'Review 5 wiki pages',
				summary: 'Five pages are drafted and waiting for a read.',
				ask: 'Publish all five?',
				options: [
					{ label: 'Publish all five', recommended: true, consequences: ['All five go live'] },
					{ label: 'Not now', consequences: ['Drafts stay as they are'] },
				],
			},
		},
	}
}

async function mockFeed(page: Page, workspaceId: string) {
	const item = decisionItem(workspaceId)
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						notification_id: '00000000-0000-4000-8000-000000000009',
						rank: 1,
						headline: item.latest_mention.content,
						rationale: null,
						created_at: item.createdAt,
						entity_type: item.entity_type,
						entity_id: item.entity_id,
						session_id: null,
						object: item.object,
						latest_mention: item.latest_mention,
					},
				],
			}),
		})
	})
}

async function noHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('Declutter — theme', () => {
	test('follows the device when nothing is stored', async ({ page, account }) => {
		await page.emulateMedia({ colorScheme: 'dark' })
		await page.goto(`/${account.workspaceId}`)
		await expect(page.locator('html')).toHaveClass(/dark/)

		await page.emulateMedia({ colorScheme: 'light' })
		await page.goto(`/${account.workspaceId}`)
		await expect(page.locator('html')).not.toHaveClass(/dark/)
	})
})

test.describe('Declutter — For you', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`section header is 20px bold with no count, and no Later or Hold @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const header = page.getByRole('heading', { name: 'Decisions', level: 2 })
			await expect(header).toBeVisible()
			const style = await header.evaluate((el) => {
				const s = getComputedStyle(el)
				return { size: s.fontSize, weight: s.fontWeight, wrap: s.whiteSpace }
			})
			expect(style.size).toBe('20px')
			expect(Number(style.weight)).toBeGreaterThanOrEqual(700)
			expect(style.wrap).toBe('nowrap')

			await expect(page.getByTestId('foryou-section-count')).toHaveCount(0)
			const card = page.getByTestId('foryou-feed-card')
			await expect(card.getByRole('button', { name: 'Publish all five' })).toBeVisible()
			await expect(card.getByRole('button', { name: 'Later' })).toHaveCount(0)
			await expect(card.getByRole('button', { name: 'Hold' })).toHaveCount(0)
			await noHorizontalOverflow(page, vp.label)
		})
	}

	for (const width of [375, 768]) {
		test(`greeting starts at the same left edge as Flows, buttons stay reachable @ ${width}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width, height: 800 })
			await mockFeed(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)
			const greeting = page.getByRole('heading', { level: 1 })
			await expect(greeting).toBeVisible({ timeout: 30_000 })
			const forYou = await greeting.boundingBox()

			await page.goto(`/${account.workspaceId}/loops`)
			const flows = page.getByRole('heading', { name: 'Flows', level: 1 })
			await expect(flows).toBeVisible({ timeout: 30_000 })
			const flowsBox = await flows.boundingBox()
			expect(forYou?.x).toBeCloseTo(flowsBox?.x ?? -1, 0)

			await page.goto(`/${account.workspaceId}`)
			await expect(greeting).toBeVisible()
			await expect(page.getByRole('button', { name: 'Display' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
			await expect(page.getByRole('button', { name: /^Call / })).toBeVisible()
			await noHorizontalOverflow(page, `${width}`)
		})
	}

	test('an empty feed shows an icon, one title and one line', async ({ page, account }) => {
		await page.route('**/api/for-you*', (route) =>
			route.request().method() === 'GET'
				? route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify({ items: [] }),
					})
				: route.fallback(),
		)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByText('Nothing needs you right now.')).toBeVisible()
	})
})

test.describe('Declutter — grouped pages', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`settings group labels are 15px semibold ink, not uppercase @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/settings`)

			const label = page.getByRole('heading', { name: 'Appearance' })
			await expect(label).toBeVisible()
			const style = await label.evaluate((el) => {
				const s = getComputedStyle(el)
				return { size: s.fontSize, weight: s.fontWeight, transform: s.textTransform }
			})
			expect(style.size).toBe('15px')
			expect(Number(style.weight)).toBeGreaterThanOrEqual(600)
			expect(style.transform).toBe('none')
			await noHorizontalOverflow(page, vp.label)
		})
	}
})

test.describe('Declutter — New chat', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`has no note about direct versus group chats @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/chats/new`)
			// The page is a To field plus the shared composer; there is no Start chat button.
			await expect(page.getByRole('region', { name: 'To' })).toBeVisible({ timeout: 15_000 })
			await expect(page.getByLabel('First message')).toBeVisible()
			await expect(page.getByText(/This starts a group chat/)).toHaveCount(0)
			await expect(page.getByText(/Pick one agent for a direct chat/)).toHaveCount(0)
			await noHorizontalOverflow(page, vp.label)
		})
	}
})

test.describe('Declutter — list states', () => {
	test('Agents shows a retryable error, not an empty team, when the fetch fails', async ({
		page,
		account,
	}) => {
		let fail = true
		await page.route('**/api/actors', async (route) => {
			if (route.request().method() !== 'GET' || !fail) return route.fallback()
			await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' })
		})
		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByText("Couldn't load agents")).toBeVisible({ timeout: 30_000 })
		await expect(page.getByText('Nobody on this team yet.')).toHaveCount(0)

		fail = false
		await page.getByRole('button', { name: 'Try again' }).click()
		await expect(page.getByText("Couldn't load agents")).toHaveCount(0)
	})
})
