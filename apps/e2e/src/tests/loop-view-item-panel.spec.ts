import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The item card beside a loop view (bet Act on items inside loop views).
 *
 * The view is a page with one button per item that calls window.maskin.open(id). The card
 * that opens is the one chat uses, acting as the person with no chat attached; every change
 * is checked against the database through the API, not the screen.
 */
const FRAME = 'iframe[title="Custom flow view"]'
const viewFrame = (page: Page) => page.frameLocator(FRAME).frameLocator('iframe')
const panel = (page: Page) => page.getByRole('region', { name: 'Item' })

async function flagOn(page: Page, on = true) {
	await page.addInitScript(
		(value) => {
			localStorage.setItem('ff:loop-view-item-panel', value)
		},
		on ? 'on' : 'off',
	)
}

async function openTab(page: Page, name: string) {
	await expect(page.getByRole('tablist', { name: 'Flow sections' })).toBeVisible({
		timeout: 15_000,
	})
	const tab = page.getByRole('tab', { name, exact: true })
	if ((await tab.count()) > 0) {
		await tab.click()
		return
	}
	// The strip's own button reads "More (n)"; the page has other buttons that start with More.
	await page.getByRole('button', { name: /^More \(\d+\)$/ }).click()
	await page.getByRole('menuitemradio', { name, exact: true }).click()
}

function viewHtml(loopId: string, items: { id: string; title: string }[]) {
	const buttons = items
		.map((i) => `<button onclick="maskin.open('${i.id}')">Open ${i.title}</button>`)
		.join('\n')
	return `<!doctype html><html><body>
<h1>Posts</h1>
${buttons}
<script id="maskin-sources" type="application/json">{"all":{"scope":"${loopId}","type":"task"}}</script>
</body></html>`
}

async function seed(account: { workspaceId: string; api: TestAPI }) {
	const { workspaceId, api } = account
	const loop = await api.createObject(workspaceId, {
		type: 'loop',
		title: 'Posts loop',
		status: 'learning',
	})
	const post = await api.createObject(workspaceId, {
		type: 'task',
		title: 'Launch post',
		status: 'todo',
		content: 'We shipped the thing. Here is what changed for you.',
	})
	const empty = await api.createObject(workspaceId, {
		type: 'task',
		title: 'Empty post',
		status: 'todo',
	})
	for (const item of [post, empty]) {
		await api.createRelationship(workspaceId, {
			source_type: 'object',
			source_id: loop.id,
			target_type: 'object',
			target_id: item.id,
			type: 'in_loop',
		})
	}
	const file = await api.createFile(workspaceId, {
		name: 'posts-view.html',
		mime_type: 'text/html',
		content: viewHtml(loop.id, [post, empty]),
	})
	await api.updateObject(loop.id, workspaceId, { metadata: { view_file_id: file.id } })
	return { loop, post, empty }
}

test.describe('Loop page: item card beside a view', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`opens the card, reads the text and moves the status @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await flagOn(page)
			const { loop, post } = await seed(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await openTab(page, 'Custom view')
			await viewFrame(page)
				.getByRole('button', { name: 'Open Launch post' })
				.click({ timeout: 15_000 })

			// The loop page stays where it is: the card opens beside the view.
			await expect(panel(page).getByText('Launch post')).toBeVisible()
			await expect(panel(page).getByText('We shipped the thing')).toBeVisible()
			await expect(page).toHaveURL(new RegExp(`/loops/${loop.id}`))
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			await panel(page)
				.getByRole('button', { name: /^Move to/ })
				.click()
			await expect
				.poll(async () => (await account.api.getObject(post.id, account.workspaceId)).status)
				.not.toBe('todo')
		})
	}

	test('an item with no text still shows its title and status', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagOn(page)
		const { loop } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Open Empty post' })
			.click({ timeout: 15_000 })

		await expect(panel(page).getByText('Empty post')).toBeVisible()
		await expect(panel(page).getByRole('button', { name: /^Move to/ })).toBeVisible()
	})

	test('refuses a status change when the item moved on since the card showed it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagOn(page)
		// No live updates, so the open card cannot hear about the move below.
		await page.route('**/api/events**', (route) => route.abort())
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Open Launch post' })
			.click({ timeout: 15_000 })
		await expect(panel(page).getByText('Launch post')).toBeVisible()

		// Someone else moves it while the card is open; the card has not heard yet.
		await account.api.updateObject(post.id, account.workspaceId, { status: 'in_progress' })
		await panel(page)
			.getByRole('button', { name: /^Move to/ })
			.click()

		await expect(panel(page).getByRole('alert')).toContainText('no longer')
		const after = await account.api.getObject(post.id, account.workspaceId)
		expect(after.status).toBe('in_progress')
	})

	test('with the flag off, Open goes to the object page as before', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagOn(page, false)
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Open Launch post' })
			.click({ timeout: 15_000 })

		await expect(page).toHaveURL(new RegExp(`/objects/${post.id}`))
	})
})
