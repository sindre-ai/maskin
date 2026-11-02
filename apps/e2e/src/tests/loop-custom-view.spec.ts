import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The agent-built custom view on the loop page, behind the loop-custom-view flag.
 *
 * The flag is switched with the client's test-only localStorage override so both sides of
 * the boundary run without a second actor. Dark mode goes through the app's own
 * maskin-theme key: the app defaults to light and ignores prefers-color-scheme unless the
 * stored theme is "system".
 *
 * The view declares one loop-scoped source and writes the count into the page, so a
 * number on screen proves the whole path: pinned file -> sandboxed frame -> bridge ->
 * GET /api/data/query against the real database. The aggregation SQL itself is covered
 * against real Postgres in apps/dev's data-query integration test.
 */
const FLAG_KEY = 'ff:loop-custom-view'
const FRAME = 'iframe[title="Custom loop view"]'

async function setFlag(page: Page, value: 'on' | 'off') {
	await page.addInitScript(
		([key, v]) => localStorage.setItem(key as string, v as string),
		[FLAG_KEY, value],
	)
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

function viewHtml(loopId: string) {
	return `<!doctype html><html><body>
<h1 id="outcome">Close the feedback backlog</h1>
<p id="headline">Loading</p>
<script id="maskin-sources" type="application/json">{"done":{"scope":"${loopId}","type":"task","filters":{"status":"done"}}}</script>
<script>maskin.query("done").then(function (r) { document.getElementById("headline").textContent = r.total.count + " tasks done" }).catch(function (e) { document.getElementById("headline").textContent = "Could not load: " + e.message })</script>
</body></html>`
}

async function seedLoopWithView(account: {
	workspaceId: string
	api: import('../helpers/api.helper').TestAPI
}) {
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title: 'Feedback loop',
		status: 'learning',
	})
	// Two done tasks in the loop, one not done, and one done task outside it: the
	// view must say 2, so scope and the status filter are both exercised.
	for (const [title, status, inLoop] of [
		['Done in loop A', 'done', true],
		['Done in loop B', 'done', true],
		['Open in loop', 'todo', true],
		['Done elsewhere', 'done', false],
	] as const) {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title,
			status,
		})
		if (inLoop) {
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'object',
				source_id: loop.id,
				target_type: 'object',
				target_id: task.id,
				type: 'in_loop',
			})
		}
	}
	const file = await account.api.createFile(account.workspaceId, {
		name: 'loop-view.html',
		mime_type: 'text/html',
		content: viewHtml(loop.id),
	})
	await account.api.updateObject(loop.id, account.workspaceId, {
		metadata: { view_file_id: file.id },
	})
	return { loop, file }
}

test.describe('Loop page — custom view', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`flag on: the pinned view renders live numbers and the toggle works @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await setFlag(page, 'on')
			const { loop } = await seedLoopWithView(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const frame = page.locator(FRAME)
			await expect(frame).toBeVisible({ timeout: 15_000 })
			// Scripts only: no same-origin access to the app's session or storage.
			await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
			const inner = page.frameLocator(FRAME)
			await expect(inner.getByText('Close the feedback backlog')).toBeVisible()
			await expect(inner.getByText('2 tasks done')).toBeVisible({ timeout: 15_000 })

			// The toggle is reachable on touch and switches both ways.
			const toggle = page.getByLabel('Loop view', { exact: true })
			await expect(toggle).toBeVisible()
			await toggle.getByRole('button', { name: 'Default' }).click()
			await expect(frame).toHaveCount(0)
			await toggle.getByRole('button', { name: 'Custom view' }).click()
			await expect(frame).toBeVisible()
			await expect(page.frameLocator(FRAME).getByText('2 tasks done')).toBeVisible({
				timeout: 15_000,
			})

			// The page itself never scrolls sideways.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}

	for (const theme of ['light', 'dark'] as const) {
		test(`flag on: the frame is visible in ${theme} mode`, async ({ page, account }) => {
			await setFlag(page, 'on')
			await setTheme(page, theme)
			const { loop } = await seedLoopWithView(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			await expect(page.locator(FRAME)).toBeVisible({ timeout: 15_000 })
			await expect(page.frameLocator(FRAME).getByText('2 tasks done')).toBeVisible({
				timeout: 15_000,
			})
		})
	}

	test('flag off: a loop with a pinned view is the default page, with no toggle and no frame', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'off')
		const { loop } = await seedLoopWithView(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await expect(page.getByRole('heading', { name: 'Feedback loop' })).toBeVisible({
			timeout: 15_000,
		})
		await expect(page.getByLabel('Loop view', { exact: true })).toHaveCount(0)
		await expect(page.locator(FRAME)).toHaveCount(0)
	})

	test('flag on with no view pinned: no toggle and no frame', async ({ page, account }) => {
		await setFlag(page, 'on')
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Plain loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await expect(page.getByRole('heading', { name: 'Plain loop' })).toBeVisible({
			timeout: 15_000,
		})
		await expect(page.getByLabel('Loop view', { exact: true })).toHaveCount(0)
		await expect(page.locator(FRAME)).toHaveCount(0)
	})

	test('flag on, view file is not HTML: falls back to the default page with a note', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'on')
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Broken view loop',
			status: 'learning',
		})
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.txt',
			mime_type: 'text/plain',
			content: 'not a view',
		})
		await account.api.updateObject(loop.id, account.workspaceId, {
			metadata: { view_file_id: file.id },
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await expect(page.getByText(/Custom view unavailable/)).toBeVisible({ timeout: 15_000 })
		await expect(page.locator(FRAME)).toHaveCount(0)
	})
})
