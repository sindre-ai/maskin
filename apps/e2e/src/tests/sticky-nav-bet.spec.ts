import { expect, test } from '../fixtures/auth.fixture'

const WIDE_DESKTOP = { width: 1280, height: 900 }
const NARROW_DESKTOP = { width: 1000, height: 900 }
const MOBILE = { width: 375, height: 812 }

const LONG_BODY = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. `.repeat(20)).join(
	'\n\n',
)

const STICKY_TITLE_MARKER = 'Sticky nav bet identity'

async function scrollHeroOff(page: import('@playwright/test').Page) {
	const scrollRoot = page.locator('[data-scroll-root]')
	await scrollRoot.evaluate((el) => {
		el.scrollTop = el.clientHeight * 2
	})
	// One rAF plus a small buffer so any scroll-driven effects flush.
	await page.waitForTimeout(200)
}

// The sticky bet-identity projection (StickyBetIdentity chip that the page
// header sprouted when the hero identity row scrolled out, + smooth-scroll-back
// that focused the status picker) was shipped with the legacy ObjectDocumentView
// header. bet/object-detail rebuilt the route around a static shell whose header
// the bet enumerates as breadcrumb + overflow menu + type/status/driver only —
// the shell keeps the `[data-hero-status-trigger]` anchor that projection
// focuses, but re-attaching the chip (and its ⌘/shape persistence) is header
// assembly owned by T5.
//
// Until T5 lands, this spec pins the interim contract: the rebuilt shell still
// scrolls inside [data-scroll-root], still hosts the hero status picker, and
// the app header's 44px invariant holds — while the not-yet-rebuilt sticky
// chip must NOT sprout. Flip the "no sticky chip" assertion when T5 lands.
test.describe('Sticky nav — bet identity (interim contract)', () => {
	for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
		test(`hero status picker present; no sticky chip until T5 (${viewport.width}px)`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize(viewport)

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: STICKY_TITLE_MARKER,
				content: LONG_BODY,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: STICKY_TITLE_MARKER })).toBeVisible({
				timeout: 10000,
			})

			// Hero identity row hosts the status picker (the marker the sticky
			// projection anchors on).
			const statusTrigger = page.locator('[data-hero-status-trigger]')
			await expect(statusTrigger).toBeVisible()

			// No sticky chip in the header, before or after the hero scrolls out.
			const header = page.locator('header')
			await expect(header.getByText(STICKY_TITLE_MARKER)).toHaveCount(0)
			await expect(header.getByRole('button', { name: /status active/i })).toHaveCount(0)

			await scrollHeroOff(page)

			await expect(statusTrigger).not.toBeInViewport()
			await expect(header.getByText(STICKY_TITLE_MARKER)).toHaveCount(0)
			await expect(header.getByRole('button', { name: /status active/i })).toHaveCount(0)
		})
	}

	test('global header stays at 44px across all three widths', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: STICKY_TITLE_MARKER,
			content: LONG_BODY,
			status: 'active',
		})

		for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
			await page.setViewportSize(viewport)
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: STICKY_TITLE_MARKER })).toBeVisible({
				timeout: 10000,
			})

			const preHeight = await page
				.locator('header')
				.evaluate((el) => el.getBoundingClientRect().height)
			expect(preHeight, `header height at ${viewport.width}px pre-scroll`).toBe(44)

			await scrollHeroOff(page)

			const postHeight = await page
				.locator('header')
				.evaluate((el) => el.getBoundingClientRect().height)
			expect(postHeight, `header height at ${viewport.width}px post-scroll`).toBe(44)
		}
	})
})

test.describe('"Create an object" section in the header New menu', () => {
	test('is absent on /objects/:id and present on /objects', async ({ page, account }) => {
		await page.setViewportSize(WIDE_DESKTOP)

		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Nav Create removal check',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(
			page.getByRole('heading', { level: 1, name: 'Nav Create removal check' }),
		).toBeVisible({
			timeout: 10000,
		})
		// The New menu itself stays available on object-detail pages (chat/loop/
		// agent/search still reachable) — only "Create an object" is hidden.
		const newButton = page.locator('header').getByRole('button', { name: /^new$/i })
		await expect(newButton).toBeVisible()
		await newButton.click()
		await expect(page.getByText('Create an object')).toHaveCount(0)
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/objects`)
		await page.locator('header').getByRole('button', { name: /^new$/i }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})

	test('is present on /agents and /triggers list surfaces', async ({ page, account }) => {
		await page.setViewportSize(WIDE_DESKTOP)

		await page.goto(`/${account.workspaceId}/agents`)
		await page.locator('header').getByRole('button', { name: /^new$/i }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/triggers`)
		await page.locator('header').getByRole('button', { name: /^new$/i }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})
})
