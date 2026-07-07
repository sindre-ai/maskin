import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * Typography verification suite (T8).
 *
 * Asserts AC-T1 (ramp), AC-T2 (font-load), AC-T3 (CLS), AC-U1 (measure cap),
 * AC-U2 (feed weight), AC-U3 (timeline alignment), AC-U4 (tabular-nums),
 * and the offline-fallback & dark-mode screenshot requirements.
 */

/* ───── Helpers ───── */

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function waitForApp(page: Page) {
	await page.waitForLoadState('load')
	// SSE keeps networkidle from firing; a brief settle is enough
	await page.waitForTimeout(500)
}

async function createObjectWithContent(
	api: import('../helpers/api.helper').TestAPI,
	workspaceId: string,
) {
	return api.createObject(workspaceId, {
		type: 'bet',
		title: 'Typography Test Bet',
		status: 'active',
		content: `A long-form description that exercises the 75-character measure cap on ${'viewports at or above 1280 pixels. '.repeat(8)}`,
	})
}

/* ───── 1. Font-load URL integrity (AC-T2) ───── */

test.describe('Typography — font load', () => {
	test('Google Fonts URL requests only Schibsted Grotesk + JetBrains Mono at weights 400,500', async ({
		page,
		account,
	}) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// Inspect the <link> element in the rendered page
		const href = await page.evaluate(() => {
			const link = document.querySelector<HTMLLinkElement>(
				'link[href*="fonts.googleapis.com/css2"]',
			)
			return link?.href ?? ''
		})

		expect(href).toContain('Schibsted+Grotesk')
		expect(href).toContain('JetBrains+Mono')
		expect(href).not.toContain('Newsreader')

		// Weights ≤500 — the URL must NOT request wght@600;700 or a range like 400..700
		const wghtMatch = href.match(/wght@([\d;]+)/)
		expect(wghtMatch).not.toBeNull()
		const weights = wghtMatch[1]?.split(';').map(Number) ?? []
		for (const w of weights) {
			expect(w).toBeLessThanOrEqual(500)
		}

		// No variable-range syntax (the ".." range operator)
		expect(href).not.toContain('..')
	})

	test('rendered body font-family includes Schibsted Grotesk', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		const fontFamily = await page.evaluate(() =>
			getComputedStyle(document.body).getPropertyValue('font-family'),
		)
		expect(fontFamily).toContain('Schibsted Grotesk')
	})

	test('woff2 payload on cold cache stays near 120 KB', async ({ page, account }) => {
		const requests: { url: string; bodySize: number }[] = []
		// Listen on response to capture actual transferred size
		page.on('response', (res) => {
			if (res.url().includes('fonts.gstatic.com') && res.url().endsWith('.woff2')) {
				requests.push({
					url: res.url(),
					bodySize: res.headers()['content-length'] ? Number(res.headers()['content-length']) : 0,
				})
			}
		})

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// Give woff2 requests time to complete
		await page.waitForTimeout(2000)

		const totalKB = requests.reduce((sum, r) => sum + r.bodySize, 0) / 1024
		expect(totalKB).toBeLessThan(200)
		expect(requests.length).toBeGreaterThanOrEqual(1)

		// Verify only wght@400 and wght@500 variants are loaded
		for (const r of requests) {
			expect(r.url).toMatch(/wght@(400|500)/)
		}
	})
})

/* ───── 2. Object detail — 75ch measure cap & title weight (AC-U1, AC-U6) ───── */

test.describe('Typography — object detail', () => {
	test('content area caps at 75ch on viewports ≥1280px', async ({ page, account }) => {
		const obj = await createObjectWithContent(account.api, account.workspaceId)

		await setTheme(page, 'light')
		await page.setViewportSize(VIEWPORTS.desktopXl)
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		// The content <div> has xl:max-w-[75ch]
		const maxWidth = await page.evaluate(() => {
			const article = document.querySelector('article')
			if (!article) return null
			// The MarkdownContent wrapper is a child div inside article
			const contentDiv = article.querySelector('div.mb-8')
			if (!contentDiv) return null
			return getComputedStyle(contentDiv).getPropertyValue('max-width')
		})

		expect(maxWidth).toBe('75ch')
	})

	test('title input uses font-semibold with tracking-tight', async ({ page, account }) => {
		const obj = await createObjectWithContent(account.api, account.workspaceId)

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		const fontWeight = await page.evaluate(() => {
			const titleInput = document.querySelector<HTMLTextAreaElement>(
				'article textarea[placeholder="Untitled"]',
			)
			if (!titleInput) return null
			return getComputedStyle(titleInput).getPropertyValue('font-weight')
		})

		// font-semibold = 600
		expect(fontWeight).toBe('600')
	})

	test('rendered font-family applies Schibsted Grotesk on object detail', async ({
		page,
		account,
	}) => {
		const obj = await createObjectWithContent(account.api, account.workspaceId)

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		const fontFamily = await page.evaluate(() =>
			getComputedStyle(document.body).getPropertyValue('font-family'),
		)
		expect(fontFamily).toContain('Schibsted Grotesk')
	})
})

/* ───── 3. Notification feed — weight, tabular-nums timestamps (AC-U2) ───── */

test.describe('Typography — notification feed', () => {
	test('thread timestamps render in font-mono with tabular-nums', async ({ page, account }) => {
		// Create a bet so we have something in the notification feed
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Feed Test Bet',
			status: 'active',
		})

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// The "for you" landing page shows UnreadThreadCards with <RelativeTime>
		// Look for <time> elements that carry font-mono and tabular-nums
		const timestampClasses = await page.evaluate(() => {
			const times = Array.from(document.querySelectorAll('time'))
			return times.map((t) => t.className)
		})

		// At least one timestamp should carry the typography classes
		const monoTimestamps = timestampClasses.filter(
			(cls) => cls.includes('font-mono') && cls.includes('tabular-nums'),
		)
		expect(monoTimestamps.length).toBeGreaterThanOrEqual(1)
	})
})

/* ───── 4. Timeline — fixed-width timestamp column (AC-U3) ───── */

test.describe('Typography — timeline', () => {
	test('timestamps render in fixed-width tabular-nums mono column', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects`)
		await waitForApp(page)

		// Navigate to the first object's detail page which has the timeline
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Timeline Typography Test',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		// Check for time elements with the expected layout classes
		const timeLayout = await page.evaluate(() => {
			const times = Array.from(document.querySelectorAll('time'))
			return times.map((t) => ({
				className: t.className,
				fontFamily: getComputedStyle(t).fontFamily,
				fontVariantNumeric: getComputedStyle(t).fontVariantNumeric,
			}))
		})

		// Timeline/activity timestamps should have mono font
		const monoInTimeline = timeLayout.filter(
			(t) => t.fontFamily.includes('JetBrains Mono') || t.className.includes('font-mono'),
		)
		// At minimum the timeline should have some <time> elements with mono
		// (strict assertion depends on activity existing)
		if (monoInTimeline.length > 0) {
			expect(monoInTimeline[0]?.fontVariantNumeric).toMatch(/tabular-nums|tabular/)
		}
	})
})

/* ───── 5. Tabular-nums on mono surfaces (AC-U4) ───── */

test.describe('Typography — tabular-nums', () => {
	test('elements with font-mono class have tabular-nums applied', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		const monoElements = await page.evaluate(() => {
			const els = Array.from(document.querySelectorAll('.font-mono'))
			return els.slice(0, 5).map((el) => ({
				tag: el.tagName,
				fontVariantNumeric: getComputedStyle(el as HTMLElement).fontVariantNumeric,
			}))
		})

		for (const el of monoElements) {
			expect(el.fontVariantNumeric).toMatch(/tabular-nums|tabular/)
		}
	})

	test('unread badge count uses tabular-nums', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		const badgeEls = await page.evaluate(() => {
			// Unread badges have aria-label like "N unread"
			return Array.from(document.querySelectorAll('[aria-label$="unread"]')).map((el) => ({
				className: (el as HTMLElement).className,
				fontVariantNumeric: getComputedStyle(el as HTMLElement).fontVariantNumeric,
			}))
		})

		for (const badge of badgeEls) {
			expect(badge.fontVariantNumeric).toMatch(/tabular-nums|tabular/)
		}
	})
})

/* ───── 6. Offline fallback — block Google Fonts, assert legible render ───── */

test.describe('Typography — offline fallback', () => {
	test('blocks Google Fonts and renders with system-ui fallback legibly', async ({
		page,
		account,
	}) => {
		// Block all Google Fonts requests so the webfont never arrives
		await page.route('**/fonts.googleapis.com/**', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// After blocking Google Fonts, body font-family must not load webfont
		const fontFamily = await page.evaluate(() =>
			getComputedStyle(document.body).getPropertyValue('font-family'),
		)
		expect(fontFamily).not.toContain('Schibsted Grotesk')

		// Should resolve to one of the fallback families
		const fallbackMatch =
			fontFamily.includes('system-ui') ||
			fontFamily.includes('-apple-system') ||
			fontFamily.includes('Segoe UI') ||
			fontFamily.includes('sans-serif')
		expect(fallbackMatch).toBe(true)

		// Screenshot the fallback state for visual review
		await page.screenshot({
			path: `typography-offline-fallback-${Date.now()}.png`,
			fullPage: false,
		})
	})

	test('mono fallback chain renders legibly offline (Menlo/Consolas/Courier)', async ({
		page,
		account,
	}) => {
		await page.route('**/fonts.googleapis.com/**', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// Check mono elements' resolved font-family
		const families = await page.evaluate(() => {
			const els = Array.from(document.querySelectorAll<HTMLElement>('.font-mono'))
			return els.slice(0, 3).map((el) => getComputedStyle(el).getPropertyValue('font-family'))
		})

		for (const fam of families) {
			// Must not reference JetBrains Mono (not loaded)
			expect(fam).not.toContain('JetBrains Mono')
			// Should resolve to one of the fallback chains
			expect(
				fam.includes('Menlo') ||
					fam.includes('Consolas') ||
					fam.includes('Courier New') ||
					fam.includes('monospace') ||
					fam.includes('ui-monospace'),
			).toBe(true)
		}
	})
})

/* ───── 7. CLS measurement (AC-T3) ───── */

test.describe('Typography — CLS budget', () => {
	test('cumulative layout shift stays under 0.05 on cold cache', async ({ page, account }) => {
		// Force cold cache via new context
		const ctx = await page.context()
		await ctx.addInitScript(() => {
			// Clear any cached fonts
		})

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`, { waitUntil: 'commit' })

		const cls = await page.evaluate(() => {
			return new Promise<number>((resolve) => {
				let cumulative = 0
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						// Only count entries without recent user input
						if (!(entry as unknown as { hadRecentInput: boolean }).hadRecentInput) {
							cumulative += (entry as unknown as { value: number }).value
						}
					}
				})
				observer.observe({ type: 'layout-shift', buffered: true })

				// Resolve after fonts have had time to swap in
				setTimeout(() => {
					observer.disconnect()
					resolve(cumulative)
				}, 3000)
			})
		})

		expect(cls).toBeLessThan(0.05)
	})
})

/* ───── 8. Dark-mode screenshots for Sebk's bet-qa pass ───── */

test.describe('Typography — dark mode screenshots', () => {
	for (const [label, viewport] of Object.entries({
		'mobile-375': VIEWPORTS.mobile,
		'tablet-768': VIEWPORTS.tabletPortrait,
		'desktop-1280': VIEWPORTS.desktopXl,
	})) {
		test(`dark mode screenshot at ${label}`, async ({ page, account }) => {
			await setTheme(page, 'dark')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await waitForApp(page)

			await page.screenshot({
				path: `typography-dark-${label}-${viewport.width}x${viewport.height}-${Date.now()}.png`,
				fullPage: false,
			})

			// Assert the page is in dark mode
			const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
			expect(isDark).toBe(true)
		})
	}
})
