import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The shared page title and margin spec: every screen's <h1> is 34px from 1024,
 * 28px at 768 and 24px below, sits on a 16 / 32 / 48px side margin at 375 / 768 / 1024, and
 * shares one left edge with the page content. Requires a live backend.
 */

const SCREENS = [
	{ path: '', heading: /^Good (night|morning|afternoon|evening)/ },
	{ path: '/loops', heading: 'Loops' },
	{ path: '/objects', heading: 'Objects' },
	{ path: '/marketplace', heading: 'Marketplace' },
	{ path: '/agents', heading: 'Agents' },
] as const

function expectedTitleSize(width: number) {
	return width >= 1024 ? '34px' : width >= 768 ? '28px' : '24px'
}

function expectedEdge(width: number) {
	return width >= 1024 ? 48 : width >= 768 ? 32 : 16
}

async function expectNoHorizontalScroll(page: Page) {
	const overflow = await page.evaluate(() => {
		const el = document.scrollingElement
		return el ? el.scrollWidth - el.clientWidth : 0
	})
	expect(overflow).toBeLessThanOrEqual(1)
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Page title layout at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		for (const screen of SCREENS) {
			test(`${String(screen.heading)}: 34 / 28 / 24px title on the shared left edge`, async ({
				page,
				account,
			}) => {
				await page.goto(`/${account.workspaceId}${screen.path}`)
				const h1 = page.getByRole('heading', {
					level: 1,
					name: screen.heading,
					exact: typeof screen.heading === 'string',
				})
				await expect(h1).toBeVisible({ timeout: 15_000 })

				const size = await h1.evaluate((el) => window.getComputedStyle(el).fontSize)
				expect(size).toBe(expectedTitleSize(vp.width))

				// The scroll root is the content edge: title x = root x + side margin.
				const root = await page.locator('[data-scroll-root]').boundingBox()
				const box = await h1.boundingBox()
				expect(root).not.toBeNull()
				expect(
					Math.abs((box?.x ?? 0) - ((root?.x ?? 0) + expectedEdge(vp.width))),
				).toBeLessThanOrEqual(1)
				await expectNoHorizontalScroll(page)
			})
		}

		test('the header keeps its top padding at or above the 20px floor', async ({
			page,
			account,
		}) => {
			// The safe-area inset is 0 in Chromium, so the computed value is the
			// fallback: 1.25rem. Anything lower would mean the inset calc was dropped.
			await page.goto(`/${account.workspaceId}/loops`)
			const header = page.getByRole('banner').first()
			await expect(header).toBeVisible({ timeout: 15_000 })
			const padTop = await header.evaluate((el) => window.getComputedStyle(el).paddingTop)
			expect(Number.parseFloat(padTop)).toBeGreaterThanOrEqual(20)
		})

		test('a detail page crumb shares the same left edge', async ({ page, account }) => {
			const object = await account.api.createObject(account.workspaceId, {
				type: 'task',
				status: 'todo',
				title: `Edge ${Date.now()}`,
			})
			await page.goto(`/${account.workspaceId}/objects/${object.id}`)
			const header = page.getByRole('banner').first()
			await expect(header).toBeVisible({ timeout: 15_000 })
			const padLeft = await header.evaluate((el) => window.getComputedStyle(el).paddingLeft)
			expect(Number.parseFloat(padLeft)).toBe(expectedEdge(vp.width))
			await expectNoHorizontalScroll(page)
		})

		test('Chats (full-bleed two-pane) keeps its height and composer reachable', async ({
			page,
			account,
		}) => {
			const chat = await account.api.createConversation(account.workspaceId, {
				title: `Edge chat ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'hello',
			})
			await page.goto(`/${account.workspaceId}/chats/${chat.id}`)
			await expect(page.getByLabel('Message this conversation')).toBeVisible({ timeout: 15_000 })
			await expectNoHorizontalScroll(page)
			const composer = await page.getByLabel('Message this conversation').boundingBox()
			expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(vp.height)
		})

		test('the Chats list column is 280px at 768', async ({ page, account }) => {
			test.skip(vp.width !== 768, 'The 280px step applies at md only')
			// The two-pane split (and its fixed-width column) only exists with a thread open.
			const chat = await account.api.createConversation(account.workspaceId, {
				title: `Column chat ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'hello',
			})
			await page.goto(`/${account.workspaceId}/chats/${chat.id}`)
			const column = page.locator('div.md\\:w-70').first()
			await expect(column).toBeVisible({ timeout: 15_000 })
			const box = await column.boundingBox()
			expect(Math.round(box?.width ?? 0)).toBe(280)
		})

		for (const scheme of ['light', 'dark'] as const) {
			test(`the title is legible in ${scheme} mode`, async ({ page, account }) => {
				await page.emulateMedia({ colorScheme: scheme })
				await page.goto(`/${account.workspaceId}/loops`)
				const h1 = page.getByRole('heading', { level: 1, name: 'Loops', exact: true })
				await expect(h1).toBeVisible({ timeout: 15_000 })
				const color = await h1.evaluate((el) => window.getComputedStyle(el).color)
				const bg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)
				expect(color).not.toBe(bg)
			})
		}
	})
}
