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

// The sticky bet-identity projection: the hero identity row owns the title and
// status picker while it is on screen, and the app header sprouts a compact
// chip (title + status, StickyBetIdentity in object-document.tsx) once the hero
// scrolls out. The v2 shell's header renders that projection through the page
// header's `stickyIdentity` slot, so the chip is live — this spec pins the
// handover in both directions rather than its earlier absence.
test.describe('Sticky nav — bet identity', () => {
	for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
		test(`the header chip takes over when the hero scrolls out (${viewport.width}px)`, async ({
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
			await expect(page.getByPlaceholder('Untitled')).toHaveValue(STICKY_TITLE_MARKER, {
				timeout: 10000,
			})

			// Hero identity row hosts the status picker (the marker the sticky
			// projection anchors on).
			const statusTrigger = page.locator('[data-hero-status-trigger]')
			await expect(statusTrigger).toBeVisible()

			// While the hero is on screen it is the only identity — no duplicate in
			// the header competing with it.
			const header = page.locator('header')
			await expect(header.getByText(STICKY_TITLE_MARKER)).toHaveCount(0)
			await expect(header.getByRole('button', { name: /status active/i })).toHaveCount(0)

			await scrollHeroOff(page)

			// Hero gone, chip sprouted — identity is never absent from the screen.
			await expect(statusTrigger).not.toBeInViewport()
			await expect(header.getByText(STICKY_TITLE_MARKER)).toBeVisible()
			await expect(header.getByRole('button', { name: /status active/i })).toBeVisible()

			// The chip is the way back: clicking it returns the hero to view, and
			// the chip stands down again.
			await header.getByRole('button', { name: /status active/i }).click()
			await expect(statusTrigger).toBeInViewport({ timeout: 10000 })
			await expect(header.getByText(STICKY_TITLE_MARKER)).toHaveCount(0)
		})
	}

	// The v2 header is a single 44px row that wraps rather than scrolls, so a
	// narrow viewport drops the right-hand cluster onto a second line instead of
	// hiding controls. The 44px invariant therefore holds where the row fits on
	// one line; below that it is a floor, not a fixed height.
	test('global header holds its 44px row on desktop and never shrinks below it', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: STICKY_TITLE_MARKER,
			content: LONG_BODY,
			status: 'active',
		})

		for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
			await page.setViewportSize(viewport)
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByPlaceholder('Untitled')).toHaveValue(STICKY_TITLE_MARKER, {
				timeout: 10000,
			})

			const exact = viewport.width >= NARROW_DESKTOP.width

			const preHeight = await page
				.locator('header')
				.evaluate((el) => el.getBoundingClientRect().height)
			if (exact) {
				expect(preHeight, `header height at ${viewport.width}px pre-scroll`).toBe(44)
			} else {
				expect(preHeight, `header height at ${viewport.width}px pre-scroll`).toBeGreaterThanOrEqual(
					44,
				)
			}

			await scrollHeroOff(page)

			const postHeight = await page
				.locator('header')
				.evaluate((el) => el.getBoundingClientRect().height)
			// Scrolling must never change the row's height, whichever regime it is in.
			expect(postHeight, `header height at ${viewport.width}px post-scroll`).toBe(preHeight)
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
		// The object title is an editable <textarea> (object-document.tsx).
		await expect(page.getByPlaceholder('Untitled')).toHaveValue('Nav Create removal check', {
			timeout: 10000,
		})
		// The New menu itself stays available on object-detail pages (chat/loop/
		// agent/search still reachable) — only "Create an object" is hidden.
		const newButton = page.locator('header').getByRole('button', { name: 'More ways to start' })
		await expect(newButton).toBeVisible()
		await newButton.click()
		await expect(page.getByText('Create an object')).toHaveCount(0)
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/objects`)
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})

	test('is present on /agents and /triggers list surfaces', async ({ page, account }) => {
		await page.setViewportSize(WIDE_DESKTOP)

		await page.goto(`/${account.workspaceId}/agents`)
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/triggers`)
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await expect(page.getByText('Create an object')).toBeVisible()
	})
})
