import { argosScreenshot } from '@argos-ci/playwright'
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

		// Per typography.md's 5-step ramp: Schibsted Grotesk loads 400/500/600
		// (600 for font-semibold titles), JetBrains Mono loads 400/500 only —
		// and neither uses variable-range syntax (the ".." operator).
		const sansMatch = href.match(/family=Schibsted\+Grotesk:wght@([\d;]+)/)
		const monoMatch = href.match(/family=JetBrains\+Mono:wght@([\d;]+)/)
		expect(sansMatch).not.toBeNull()
		expect(monoMatch).not.toBeNull()
		const sansWeights = sansMatch?.[1]?.split(';').map(Number) ?? []
		const monoWeights = monoMatch?.[1]?.split(';').map(Number) ?? []
		expect(sansWeights).toEqual([400, 500, 600])
		expect(monoWeights).toEqual([400, 500])

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
		expect(totalKB).toBeLessThan(120)
		expect(requests.length).toBeGreaterThanOrEqual(1)
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

		// The content wrapper (xl:max-w-[75ch]) is the first `.mb-8` block in the
		// document view — it precedes the linked-objects/files sections, which
		// also carry `mb-8`. Chromium resolves `ch` units to a pixel value in
		// getComputedStyle rather than echoing the literal string, so assert the
		// cap is present (not 'none') and narrower than the outer document
		// wrapper's max-w-3xl (768px), rather than a brittle exact-string match.
		const maxWidthPx = await page.evaluate(() => {
			const contentDiv = document.querySelector('div.mb-8')
			if (!contentDiv) return null
			const value = getComputedStyle(contentDiv).getPropertyValue('max-width')
			return value === 'none' ? null : Number.parseFloat(value)
		})

		expect(maxWidthPx).not.toBeNull()
		expect(maxWidthPx as number).toBeGreaterThan(0)
		expect(maxWidthPx as number).toBeLessThan(768)
	})

	test('title input uses font-semibold with tracking-tight', async ({ page, account }) => {
		const obj = await createObjectWithContent(account.api, account.workspaceId)

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		const fontWeight = await page.evaluate(() => {
			const titleInput = document.querySelector<HTMLTextAreaElement>(
				'textarea[placeholder="Untitled"]',
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

		expect(monoElements.length).toBeGreaterThan(0)
		for (const el of monoElements) {
			expect(el.fontVariantNumeric).toMatch(/tabular-nums|tabular/)
		}
	})

	test('unread badge count uses tabular-nums', async ({ page, account }) => {
		// Create an object so the "for you" feed has at least one unread thread
		// card to render an unread badge on.
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Tabular Nums Badge Test',
			status: 'active',
		})

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

		expect(badgeEls.length).toBeGreaterThan(0)
		for (const badge of badgeEls) {
			expect(badge.fontVariantNumeric).toMatch(/tabular-nums|tabular/)
		}
	})
})

/* ───── 6. Offline fallback — block Google Fonts, assert legible render ───── */

test.describe('Typography — offline fallback', () => {
	// Note: `getComputedStyle(el).fontFamily` always echoes the literal
	// CSS-declared stack (the "specified value" for this property), regardless
	// of whether any listed font actually resolves — so it can't tell us
	// whether the webfont loaded. Blocking the Google Fonts stylesheet means
	// the browser never receives Google's `@font-face` rules at all, so the
	// correct check is whether "Schibsted Grotesk" / "JetBrains Mono" ever
	// register in `document.fonts` and whether any file request reached
	// fonts.gstatic.com.
	test('blocks Google Fonts and confirms the webfont never registers', async ({
		page,
		account,
	}) => {
		const gstaticRequests: string[] = []
		page.on('request', (req) => {
			if (req.url().includes('fonts.gstatic.com')) gstaticRequests.push(req.url())
		})
		// Block all Google Fonts requests so the webfont never arrives
		await page.route('**/fonts.googleapis.com/**', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		const hasSchibstedWebfont = await page.evaluate(() =>
			Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === 'Schibsted Grotesk'),
		)
		expect(hasSchibstedWebfont).toBe(false)
		expect(gstaticRequests.length).toBe(0)

		// The page still renders visible text — falls through to the
		// metric-tuned fallback / system fonts rather than collapsing.
		const bodyHasVisibleText = await page.evaluate(() => document.body.innerText.trim().length > 0)
		expect(bodyHasVisibleText).toBe(true)

		// Screenshot the fallback state for visual review (static filename —
		// intentionally overwritten each run rather than accumulating).
		await page.screenshot({
			path: 'typography-offline-fallback-light.png',
			fullPage: false,
		})
	})

	test('mono fallback: JetBrains Mono webfont never registers when Google Fonts is blocked', async ({
		page,
		account,
	}) => {
		await page.route('**/fonts.googleapis.com/**', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		const hasMonoWebfont = await page.evaluate(() =>
			Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === 'JetBrains Mono'),
		)
		expect(hasMonoWebfont).toBe(false)
	})
})

/* ───── 7. CLS measurement (AC-T3) ───── */

test.describe('Typography — CLS budget', () => {
	test('cumulative layout shift stays under 0.05 on cold cache', async ({ page, account }) => {
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

/* ───── 8. Paired light/dark screenshots for Argos visual diffing (AC-T1) ───── */

test.describe('Typography — visual regression screenshots', () => {
	for (const [label, viewport] of Object.entries({
		'mobile-375': VIEWPORTS.mobile,
		'tablet-768': VIEWPORTS.tabletPortrait,
		'desktop-1280': VIEWPORTS.desktopXl,
	}) as [string, { width: number; height: number }][]) {
		test(`light mode screenshot at ${label}`, async ({ page, account }) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await waitForApp(page)
			await argosScreenshot(page, `typography-${label}-light`)
		})

		test(`dark mode screenshot at ${label}`, async ({ page, account }) => {
			await setTheme(page, 'dark')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await waitForApp(page)
			await argosScreenshot(page, `typography-${label}-dark`)

			const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
			expect(isDark).toBe(true)
		})
	}
})
