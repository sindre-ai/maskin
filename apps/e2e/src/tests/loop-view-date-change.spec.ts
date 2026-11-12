import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * A date change from a loop view (bet Act on items inside loop views).
 *
 * The view is a small Calendar: one button per post to move it to another day, and one to set
 * a post time. A button only proposes (window.maskin.propose); the page asks "Move to 14 Nov?"
 * and saves after the person says yes. Every outcome is checked against the database through
 * the API, not the screen.
 */
// A reload loads a hidden replacement frame beside this one until it has drawn.
const FRAME = 'iframe[title="Custom flow view"]:not([aria-hidden])'
const viewFrame = (page: Page) => page.frameLocator(FRAME).frameLocator('iframe')

async function flagsOn(page: Page, on = true) {
	await page.addInitScript(
		(value) => {
			localStorage.setItem('ff:loop-view-date-change', value)
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
	await page.getByRole('button', { name: /^More/ }).click()
	await page.getByRole('menuitemradio', { name, exact: true }).click()
}

/** The Calendar: each post shows its day and time, and has buttons that only propose a change. */
function calendarHtml() {
	return `<!doctype html><html><body>
<h1>Calendar</h1>
<div id="posts"></div>
<script id="maskin-sources" type="application/json">{"posts":{"list":"objects","params":{"type":"task","where":{"platform":"linkedin"},"fields":["scheduled_date","post_time"]}}}</script>
<script>
maskin.query('posts').then(function (a) {
  var el = document.getElementById('posts')
  a.rows.forEach(function (r) {
    var d = document.createElement('div')
    d.innerHTML = '<span>' + r.title + ' on ' + r.scheduled_date + ' at ' + r.post_time + '</span> '
    var move = document.createElement('button')
    move.textContent = 'Drag ' + r.title + ' to 14 Nov'
    move.onclick = function () { maskin.propose(r.id, 'scheduled_date', '2026-11-14') }
    var time = document.createElement('button')
    time.textContent = 'Set ' + r.title + ' to 09:30'
    time.onclick = function () { maskin.propose(r.id, 'post_time', '09:30') }
    var sneaky = document.createElement('button')
    sneaky.textContent = 'Archive ' + r.title
    sneaky.onclick = function () { maskin.propose(r.id, 'status', 'done'); maskin.propose(r.id, 'title', 'Hacked') }
    d.appendChild(move); d.appendChild(time); d.appendChild(sneaky)
    el.appendChild(d)
  })
})
</script>
</body></html>`
}

async function seed(account: { workspaceId: string; api: TestAPI }) {
	const { workspaceId, api } = account
	const loop = await api.createObject(workspaceId, {
		type: 'loop',
		title: 'Calendar loop',
		status: 'learning',
	})
	const post = await api.createObject(workspaceId, {
		type: 'task',
		title: 'Launch post',
		status: 'todo',
		metadata: { platform: 'linkedin', scheduled_date: '2026-11-12', post_time: '08:00' },
	})
	const file = await api.createFile(workspaceId, {
		name: 'calendar-view.html',
		mime_type: 'text/html',
		content: calendarHtml(),
	})
	await api.updateObject(loop.id, workspaceId, { metadata: { view_file_id: file.id } })
	return { loop, post }
}

const dateOf = async (account: { workspaceId: string; api: TestAPI }, id: string) =>
	(await account.api.getObject(id, account.workspaceId)).metadata as {
		scheduled_date: string
		post_time: string
	}

test.describe('Loop page: date change from a view', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`asks first, then moves the day and sets the time @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await flagsOn(page)
			const { loop, post } = await seed(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await openTab(page, 'Custom view')
			await viewFrame(page)
				.getByRole('button', { name: 'Drag Launch post to 14 Nov' })
				.click({ timeout: 15_000 })

			// Asked, and nothing saved yet.
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Move to 14 Nov?')).toBeVisible()
			expect((await dateOf(account, post.id)).scheduled_date).toBe('2026-11-12')

			await dialog.getByRole('button', { name: 'Move' }).click()
			await expect(dialog).toBeHidden()
			await expect
				.poll(async () => (await dateOf(account, post.id)).scheduled_date)
				.toBe('2026-11-14')
			// The other field and the status were not touched.
			expect((await dateOf(account, post.id)).post_time).toBe('08:00')
			expect((await account.api.getObject(post.id, account.workspaceId)).status).toBe('todo')
			// The view reloaded and shows the new day.
			await expect(viewFrame(page).getByText(/Launch post on 2026-11-14/)).toBeVisible()

			await viewFrame(page).getByRole('button', { name: 'Set Launch post to 09:30' }).click()
			await expect(dialog.getByText('Set post time to 09:30?')).toBeVisible()
			await dialog.getByRole('button', { name: 'Set time' }).click()
			await expect.poll(async () => (await dateOf(account, post.id)).post_time).toBe('09:30')
		})
	}

	test('saves nothing when the person cancels', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagsOn(page)
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Drag Launch post to 14 Nov' })
			.click({ timeout: 15_000 })
		const dialog = page.getByRole('dialog')
		await expect(dialog.getByText('Move to 14 Nov?')).toBeVisible()
		await dialog.getByRole('button', { name: 'Cancel' }).click()

		await expect(dialog).toBeHidden()
		await page.waitForTimeout(500)
		expect((await dateOf(account, post.id)).scheduled_date).toBe('2026-11-12')
	})

	test('refuses the change when the item moved on since the question was asked', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagsOn(page)
		// No live updates, so the open question cannot hear about the move below.
		await page.route('**/api/events**', (route) => route.abort())
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Drag Launch post to 14 Nov' })
			.click({ timeout: 15_000 })
		const dialog = page.getByRole('dialog')
		await expect(dialog.getByText('Move to 14 Nov?')).toBeVisible()

		// Someone else moves it on while the question is open.
		await account.api.updateObject(post.id, account.workspaceId, { status: 'in_progress' })
		await dialog.getByRole('button', { name: 'Move' }).click()

		await expect(dialog.getByRole('alert')).toContainText('no longer')
		expect((await dateOf(account, post.id)).scheduled_date).toBe('2026-11-12')
	})

	test('a view cannot propose any field it was not allowed, and asks nothing', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagsOn(page)
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Archive Launch post' })
			.click({ timeout: 15_000 })

		await page.waitForTimeout(500)
		await expect(page.getByRole('dialog')).toHaveCount(0)
		const after = await account.api.getObject(post.id, account.workspaceId)
		expect(after.status).toBe('todo')
		expect(after.title).toBe('Launch post')
	})

	test('with the flag off, a proposal is ignored', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await flagsOn(page, false)
		const { loop, post } = await seed(account)

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')
		await viewFrame(page)
			.getByRole('button', { name: 'Drag Launch post to 14 Nov' })
			.click({ timeout: 15_000 })

		await page.waitForTimeout(500)
		await expect(page.getByRole('dialog')).toHaveCount(0)
		expect((await dateOf(account, post.id)).scheduled_date).toBe('2026-11-12')
	})
})
