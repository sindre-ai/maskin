import { expect, test } from '../fixtures/auth.fixture'

const WIDE_DESKTOP = { width: 1280, height: 900 }
const NARROW_DESKTOP = { width: 1000, height: 900 }
const MOBILE = { width: 375, height: 812 }

const LONG_BODY = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. `.repeat(20)).join(
	'\n\n',
)

const STICKY_TITLE_MARKER = 'Sticky nav bet identity'

async function scrollHeroOff(page: import('@playwright/test').Page) {
	// The v2 shell publishes `scrollLocked`, which makes the layout's
	// `[data-scroll-root]` `overflow-hidden` and hands scrolling to the document
	// region inside it (object-detail-shell.tsx). Scrolling the outer root here
	// is a no-op, so the hero never leaves the viewport.
	const scrollRoot = page.locator('[data-detail-scroll-region]')
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
// This spec pins the contract: the shell still scrolls inside
// [data-scroll-root], still hosts the hero status picker, and its detail bar
// stays a fixed height — while the sticky chip must NOT sprout. The bar does
// carry the object's name in its crumb (mockup 1033–1035), so "no projection"
// is now about the status chip and about the bar not changing on scroll, not
// about the name being absent from the header.
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

			// The crumb names the object at rest; no status chip sprouts, before or
			// after the hero scrolls out.
			const header = page.locator('main header').first()
			await expect(header.getByText(STICKY_TITLE_MARKER)).toBeVisible()
			await expect(header.getByRole('button', { name: /status active/i })).toHaveCount(0)

			await scrollHeroOff(page)

			await expect(statusTrigger).not.toBeInViewport()
			await expect(header.getByText(STICKY_TITLE_MARKER)).toBeVisible()
			await expect(header.getByRole('button', { name: /status active/i })).toHaveCount(0)
		})
	}

	// The detail bar is taller than the 44px list-screen nav — the mockup gives
	// it 13px of padding around a 28px control (1033), i.e. 55px with the bottom
	// border, while the built bar measures 57 because its controls are 30px.
	// That 2px is a design question, not the one this test answers: the contract
	// here is that the bar is the SAME height at every width and does not shift
	// when the hero scrolls out from under it. So the first measurement sets the
	// expectation and every later one must match it, with a loose band that
	// still catches a bar that collapses or doubles.
	const MIN_BAR_HEIGHT = 44
	const MAX_BAR_HEIGHT = 72
	test('detail bar keeps one height across all three widths', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: STICKY_TITLE_MARKER,
			content: LONG_BODY,
			status: 'active',
		})

		let expectedHeight: number | undefined

		for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
			await page.setViewportSize(viewport)
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: STICKY_TITLE_MARKER })).toBeVisible({
				timeout: 10000,
			})

			const bar = page.locator('main header').first()
			const preHeight = await bar.evaluate((el) => el.getBoundingClientRect().height)
			if (expectedHeight === undefined) {
				expect(preHeight, 'detail bar height').toBeGreaterThanOrEqual(MIN_BAR_HEIGHT)
				expect(preHeight, 'detail bar height').toBeLessThanOrEqual(MAX_BAR_HEIGHT)
				expectedHeight = preHeight
			}
			expect(preHeight, `bar height at ${viewport.width}px pre-scroll`).toBe(expectedHeight)

			await scrollHeroOff(page)

			const postHeight = await bar.evaluate((el) => el.getBoundingClientRect().height)
			expect(postHeight, `bar height at ${viewport.width}px post-scroll`).toBe(expectedHeight)
		}
	})
})

test.describe('"Create an object" section in the header New menu', () => {
	// The object page carries the same split New button as every other screen
	// (mockup 925–946), so its menu offers the same sections — the earlier
	// contract that hid "Create an object" here is superseded.
	test('is present on /objects/:id and on /objects', async ({ page, account }) => {
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
		const newButton = page.locator('main header').first().getByRole('button', { name: /^New / })
		await expect(newButton).toBeVisible()
		await newButton.click()
		await expect(page.getByText('Create an object')).toBeVisible()
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/objects`)
		await page.locator('header').getByRole('button', { name: /^New/ }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})

	test('is present on /agents and /triggers list surfaces', async ({ page, account }) => {
		await page.setViewportSize(WIDE_DESKTOP)

		await page.goto(`/${account.workspaceId}/agents`)
		await page.locator('header').getByRole('button', { name: /^New/ }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/triggers`)
		await page.locator('header').getByRole('button', { name: /^New/ }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})
})
