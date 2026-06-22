import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1

const CHART_SPEC = {
	type: 'bar',
	x: 'day',
	series: ['retention'],
	data: [
		{ day: 'Mon', retention: 38 },
		{ day: 'Tue', retention: 42 },
		{ day: 'Wed', retention: 51 },
		{ day: 'Thu', retention: 56 },
	],
	caption: 'week-1 retention · 38% → 56%',
}

function chartCommentContent(): string {
	return ['Week-1 retention is up.', '', '```chart', JSON.stringify(CHART_SPEC), '```'].join('\n')
}

test.describe('Rich agent-reply renderer (T1)', () => {
	test('renders a ```chart fenced block as a recharts visual on bet detail', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `Rich-reply bet ${Date.now()}`,
			status: 'active',
		})

		await account.api.createComment(account.workspaceId, {
			entity_id: bet.id,
			content: chartCommentContent(),
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		// Wait for the activity timeline to render the comment + chart figure.
		const chart = page.getByTestId('comment-chart').first()
		await expect(chart).toBeVisible({ timeout: 15000 })
		await expect(page.getByText('week-1 retention · 38% → 56%')).toBeVisible()
	})

	test('renders a metadata.tasks comment as a live checklist that updates over SSE', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `Checklist bet ${Date.now()}`,
			status: 'active',
		})
		const taskA = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Open task A',
			status: 'todo',
		})
		const taskB = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Open task B',
			status: 'todo',
		})

		await account.api.createComment(account.workspaceId, {
			entity_id: bet.id,
			content: 'Tracking work',
			metadata: { tasks: [taskA.id, taskB.id] },
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		const list = page.getByTestId('comment-task-list').first()
		await expect(list).toBeVisible({ timeout: 15000 })
		await expect(list.getByText('Open task A')).toBeVisible()
		await expect(list.getByText('Open task B')).toBeVisible()

		// Both rows start unchecked.
		const initialChecks = await list.locator('button[role="checkbox"]').all()
		expect(initialChecks.length).toBe(2)
		for (const cb of initialChecks) {
			await expect(cb).toHaveAttribute('data-state', 'unchecked')
		}

		// Flip Task A to completed via the API — the SSE invalidation should
		// refetch the task object and re-render its row as checked, no reload.
		await account.api.updateObject(taskA.id, { status: 'completed' })

		const checkboxForA = list
			.locator('li')
			.filter({ hasText: 'Open task A' })
			.locator('button[role="checkbox"]')
		await expect(checkboxForA).toHaveAttribute('data-state', 'checked', { timeout: 10000 })
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`chart figure stays within the comment row at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Overflow bet ${Date.now()}`,
				status: 'active',
			})
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: chartCommentContent(),
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			const { scrollWidth, innerWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(
				scrollWidth,
				`page must not overflow horizontally with an inline chart at ${viewport.label}`,
			).toBeLessThanOrEqual(innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)

			// The chart figure itself must also stay within its comment row's
			// content area — covers AC-T5's `chartElement.scrollWidth ≤ commentRow.clientWidth`.
			await expect(page.getByTestId('comment-chart').first()).toBeVisible({ timeout: 15000 })
			const overflow = await page.evaluate(() => {
				const fig = document.querySelector('[data-testid="comment-chart"]') as HTMLElement | null
				if (!fig) return null
				const row = fig.closest('div') as HTMLElement | null
				if (!row) return null
				return { figScroll: fig.scrollWidth, rowClient: row.clientWidth }
			})
			expect(overflow).not.toBeNull()
			expect(overflow?.figScroll ?? 0).toBeLessThanOrEqual(
				(overflow?.rowClient ?? 0) + HORIZONTAL_OVERFLOW_TOLERANCE_PX,
			)
		})
	}

	test('chart renders without console errors in both light and dark mode', async ({
		page,
		account,
	}) => {
		const errors: string[] = []
		page.on('pageerror', (e) => errors.push(e.message))
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(msg.text())
		})

		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `Theme bet ${Date.now()}`,
			status: 'active',
		})
		await account.api.createComment(account.workspaceId, {
			entity_id: bet.id,
			content: chartCommentContent(),
		})

		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByTestId('comment-chart').first()).toBeVisible({ timeout: 15000 })
		}

		expect(errors, `chart render must not log errors: ${errors.join(' | ')}`).toHaveLength(0)
	})
})
