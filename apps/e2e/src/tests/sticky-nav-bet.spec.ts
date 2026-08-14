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
	// One rAF plus a small buffer so IntersectionObserver has time to flush.
	await page.waitForTimeout(200)
}

test.describe('Sticky nav — bet identity', () => {
	for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
		test(`shows title + read-only chip after the hero scrolls off (${viewport.width}px)`, async ({
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
			await expect(page.locator('textarea').first()).toHaveValue(STICKY_TITLE_MARKER, {
				timeout: 10000,
			})

			// The dot-word chip renders inside the hero row before scroll (as the
			// editable StatusSelect isn't a dot-word). No sticky chip in header yet.
			const header = page.locator('header')
			await expect(header.getByText(STICKY_TITLE_MARKER)).toHaveCount(0)

			await scrollHeroOff(page)

			// After scroll: the sticky projection appears in the header. The
			// desktop and mobile slots each get their own DOM node, so filter to
			// the one that's actually visible at the current viewport before
			// asserting.
			await expect(
				header.getByText(STICKY_TITLE_MARKER).filter({ visible: true }).first(),
			).toBeVisible()
			await expect(header.getByRole('button', { name: /status active/i }).first()).toBeVisible()
		})
	}

	test('sticky chip smooth-scrolls back to hero and focuses the status picker', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(WIDE_DESKTOP)

		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: STICKY_TITLE_MARKER,
			content: LONG_BODY,
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.locator('textarea').first()).toHaveValue(STICKY_TITLE_MARKER, {
			timeout: 10000,
		})

		await scrollHeroOff(page)

		const chip = page
			.locator('header')
			.getByRole('button', { name: /status active/i })
			.first()
		await expect(chip).toBeVisible()
		await chip.click()

		// The scrollIntoView('smooth') plus the deferred focus land the user back
		// on the hero StatusSelect trigger. Give the smooth-scroll a beat.
		const trigger = page.locator('[data-hero-status-trigger]')
		await expect(trigger).toBeFocused({ timeout: 2000 })
	})

	test('header stays at 44px across all three widths', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: STICKY_TITLE_MARKER,
			content: LONG_BODY,
			status: 'active',
		})

		for (const viewport of [WIDE_DESKTOP, NARROW_DESKTOP, MOBILE]) {
			await page.setViewportSize(viewport)
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.locator('textarea').first()).toHaveValue(STICKY_TITLE_MARKER, {
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
		await expect(page.locator('textarea').first()).toHaveValue('Nav Create removal check', {
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
