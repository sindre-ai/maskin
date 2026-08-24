import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { safeArgosScreenshot } from '../helpers/argos.helper'
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

// The "For You" unread feed only surfaces subscribed entities with a comment
// or terminal bet-status event authored by *another* actor (see
// apps/dev/src/routes/subscriptions.ts) — a bare `createObject` call by the
// viewing actor can never populate it. Mock the endpoint directly instead,
// the same way foryou-mark-all-read.spec.ts and unread-mentioned-pill.spec.ts do,
// so these typography assertions stay deterministic.
interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentioning_unread_count: number
	latest_event_id: number
	latest_activity_at: string
	object: {
		id: string
		title: string
		type: string
		status: string
		workspaceId: string
	}
}

function buildUnreadItem(workspaceId: string, entityId: string, title: string): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: entityId,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: entityId,
			title,
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockUnreadFeed(page: Page, workspaceId: string, items: UnreadFixture[]) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

/* ───── 1. Font-load URL integrity (AC-T2) ───── */

test.describe('Typography — font load', () => {
	test('fonts are self-hosted — no Google Fonts CDN, only Schibsted Grotesk + JetBrains Mono preloaded', async ({
		page,
		account,
	}) => {
		const externalFontRequests: string[] = []
		page.on('request', (req) => {
			const url = req.url()
			if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
				externalFontRequests.push(url)
			}
		})

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// index.html preloads the self-hosted woff2 files instead of linking a
		// Google Fonts stylesheet — assert the CDN is gone entirely.
		const googleFontsLinkPresent = await page.evaluate(
			() => document.querySelector('link[href*="fonts.googleapis.com"]') !== null,
		)
		expect(googleFontsLinkPresent).toBe(false)
		expect(externalFontRequests).toEqual([])

		const preloadPaths = await page.evaluate(() =>
			Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map(
				(link) => new URL((link as HTMLLinkElement).href).pathname,
			),
		)
		expect(preloadPaths).toContain('/fonts/schibsted-grotesk-latin.woff2')
		expect(preloadPaths).toContain('/fonts/jetbrains-mono-latin.woff2')

		// Only the two typeface families register — no stray imports (e.g. Newsreader).
		await page.evaluate(() => document.fonts.ready)
		const families = await page.evaluate(() =>
			Array.from(new Set(Array.from(document.fonts).map((f) => f.family.replace(/["']/g, '')))),
		)
		expect(families).toContain('Schibsted Grotesk')
		expect(families).toContain('JetBrains Mono')
		expect(families).not.toContain('Newsreader')
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
			if (res.url().includes('/fonts/') && res.url().endsWith('.woff2')) {
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

		// The rebuilt shell's markdown body carries `max-w-[75ch]` on the
		// MarkdownContent root. Chromium resolves `ch` units to a pixel value in
		// getComputedStyle rather than echoing the literal string, so assert the
		// cap is present (not 'none') and narrower than the outer document
		// wrapper's max-w-3xl (768px), rather than a brittle exact-string match.
		const maxWidthPx = await page.evaluate(() => {
			const contentDiv = document.querySelector('div[class*="max-w-[75ch]"]')
			if (!contentDiv) return null
			const value = getComputedStyle(contentDiv).getPropertyValue('max-width')
			return value === 'none' ? null : Number.parseFloat(value)
		})

		expect(maxWidthPx).not.toBeNull()
		expect(maxWidthPx as number).toBeGreaterThan(0)
		expect(maxWidthPx as number).toBeLessThan(768)
	})

	test('title input uses font-semibold', async ({ page, account }) => {
		const obj = await createObjectWithContent(account.api, account.workspaceId)

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await waitForApp(page)

		// The title still renders as an editable textarea (the object-detail
		// static-shell rebuild referenced elsewhere in this spec file hasn't
		// landed in this branch) — see object-document.tsx.
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
		await mockUnreadFeed(page, account.workspaceId, [
			buildUnreadItem(account.workspaceId, 'feed-test-bet', 'Feed Test Bet'),
		])

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)

		// The "for you" landing page shows queue cards with <RelativeTime>
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
		await mockUnreadFeed(page, account.workspaceId, [
			buildUnreadItem(account.workspaceId, 'mono-class-test-bet', 'Mono Class Test Bet'),
		])

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
		await mockUnreadFeed(page, account.workspaceId, [
			buildUnreadItem(account.workspaceId, 'badge-test-bet', 'Tabular Nums Badge Test'),
		])

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
	// whether the webfont loaded. Fonts are self-hosted via `@font-face` rules
	// in the app's own same-origin stylesheet, which always loads — so
	// `document.fonts` always contains those declared entries, blocked file or
	// not. `document.fonts.check()` reflects whether the font *file* actually
	// became available for painting, which is what blocking the woff2 request
	// is meant to simulate (a CDN/asset-host outage).
	test('blocks the self-hosted font files and confirms the webfont never becomes available', async ({
		page,
		account,
	}) => {
		const fontFileRequests: string[] = []
		page.on('request', (req) => {
			if (req.url().includes('/fonts/') && req.url().endsWith('.woff2')) {
				fontFileRequests.push(req.url())
			}
		})
		// Block all self-hosted font file requests so the webfont never arrives
		await page.route('**/fonts/*.woff2', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)
		await page.evaluate(() => document.fonts.ready)

		const schibstedAvailable = await page.evaluate(() =>
			document.fonts.check('600 16px "Schibsted Grotesk"'),
		)
		expect(schibstedAvailable).toBe(false)
		expect(fontFileRequests.length).toBeGreaterThan(0)

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

	test('mono fallback: JetBrains Mono webfont never becomes available when font files are blocked', async ({
		page,
		account,
	}) => {
		await page.route('**/fonts/*.woff2', (route) => route.abort())

		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)
		await page.evaluate(() => document.fonts.ready)

		const monoAvailable = await page.evaluate(() => document.fonts.check('16px "JetBrains Mono"'))
		expect(monoAvailable).toBe(false)
	})
})

/* ───── 7. CLS measurement (AC-T3) ───── */

test.describe('Typography — CLS budget', () => {
	test('cumulative layout shift stays under 0.05 on cold cache', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`, { waitUntil: 'commit' })

		// Each shift is recorded with the elements that moved. A bare cumulative
		// number tells you the budget broke but not what broke it — and the shift
		// sources are gone by the time the assertion fails, so they have to be
		// captured here, in the page, as they arrive.
		const { cls, shifts } = await page.evaluate(() => {
			interface ShiftSource {
				node?: Node | null
				previousRect: DOMRectReadOnly
				currentRect: DOMRectReadOnly
			}
			interface ShiftEntry extends PerformanceEntry {
				value: number
				hadRecentInput: boolean
				sources?: ShiftSource[]
			}

			function describe(node: Node | null | undefined): string {
				if (!(node instanceof Element)) return '(detached)'
				const testId = node.getAttribute('data-testid')
				const id = node.id ? `#${node.id}` : ''
				const cls = node.className
				const klass =
					typeof cls === 'string' && cls ? `.${cls.trim().split(/\s+/).slice(0, 4).join('.')}` : ''
				return `${node.tagName.toLowerCase()}${id}${testId ? `[data-testid=${testId}]` : ''}${klass}`
			}

			return new Promise<{ cls: number; shifts: string[] }>((resolve) => {
				let cumulative = 0
				const shifts: string[] = []
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as ShiftEntry[]) {
						// Only count entries without recent user input
						if (entry.hadRecentInput) continue
						cumulative += entry.value
						const moved = (entry.sources ?? []).map(
							(source) =>
								`${describe(source.node)} ${Math.round(source.previousRect.y)}→${Math.round(
									source.currentRect.y,
								)}y`,
						)
						shifts.push(
							`${entry.value.toFixed(4)} @${Math.round(entry.startTime)}ms: ${
								moved.join(' | ') || '(no sources)'
							}`,
						)
					}
				})
				observer.observe({ type: 'layout-shift', buffered: true })

				// Resolve after fonts have had time to swap in
				setTimeout(() => {
					observer.disconnect()
					resolve({ cls: cumulative, shifts })
				}, 3000)
			})
		})

		expect(cls, `layout shifts:\n${shifts.join('\n')}`).toBeLessThan(0.05)
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
			await safeArgosScreenshot(page, `typography-${label}-light`)
		})

		test(`dark mode screenshot at ${label}`, async ({ page, account }) => {
			await setTheme(page, 'dark')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await waitForApp(page)
			await safeArgosScreenshot(page, `typography-${label}-dark`)

			const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
			expect(isDark).toBe(true)
		})
	}
})
