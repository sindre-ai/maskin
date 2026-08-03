import type { ConsoleMessage, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

// For You + featured briefing PostHog wire (T6 / bet fyp-briefing-first).
//
// Proves the app's code fires each ship-metric event at the right moment in a
// real browser — not that the SDK works in isolation. The trackEvent() helper
// writes `console.info('[analytics]', payload)` when PostHog isn't initialised,
// which is the deterministic signal we assert against here. VITE_POSTHOG_KEY
// is unset in the test webServer env, so no HTTP capture goes out and the
// console log is guaranteed to fire on every trackEvent call.
//
// The five events under test (verbatim from the bet's `metadata.posthog_query`):
//   workspace_session_start · fyp_opened_first · fyp_session_opened
//   fyp_briefing_read · fyp_briefing_audio_played

const BRIEFING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BRIEFING_ID_ALT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const FILE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

interface AnalyticsEvent {
	name: string
	[key: string]: unknown
}

function collectAnalytics(page: Page): AnalyticsEvent[] {
	const events: AnalyticsEvent[] = []
	page.on('console', (msg: ConsoleMessage) => {
		if (msg.type() !== 'info') return
		const text = msg.text()
		if (!text.startsWith('[analytics]')) return
		try {
			const payload = JSON.parse(text.slice('[analytics] '.length))
			events.push(payload)
		} catch {
			// Non-JSON console.info — ignore.
		}
	})
	return events
}

function eventsNamed(events: AnalyticsEvent[], name: string): AnalyticsEvent[] {
	return events.filter((e) => e.name === name)
}

async function mockBriefingRoutes(page: Page, briefingId: string, workspaceId: string) {
	await page.route('**/api/briefing/latest*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				object: {
					id: briefingId,
					workspaceId,
					type: 'knowledge',
					title: 'Daily briefing',
					// Long body so the 50%-of-body sentinel starts below the fold on a
					// standard viewport — scroll is required to reach the impression.
					content: Array.from(
						{ length: 60 },
						(_, i) => `- Line ${i + 1}: filler prose for scroll depth.`,
					).join('\n'),
					status: 'validated',
					metadata: { kind: 'briefing' },
					driver: null,
					activeSessionId: null,
					createdBy: '00000000-0000-0000-0000-000000000000',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				audioFileId: FILE_ID,
				unreadDelta: 1,
			}),
		})
	})
	await page.route(`**/api/files/${FILE_ID}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: FILE_ID,
				workspaceId,
				name: 'briefing.mp3',
				description: null,
				mimeType: 'audio/mpeg',
				sizeBytes: 8,
				storageKey: 'briefings/mock.mp3',
				createdBy: '00000000-0000-0000-0000-000000000000',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				content: 'AAAAAAAAAA==',
				encoding: 'base64',
				url: `/api/files/${FILE_ID}/download`,
				annotations: [],
			}),
		})
	})
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})
	await page.route('**/api/events*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

test.describe('For You + briefing PostHog wire', () => {
	test('session events fire once per tab on the first For You mount', async ({ page, account }) => {
		const events = collectAnalytics(page)
		await mockBriefingRoutes(page, BRIEFING_ID, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('briefing-card')).toBeVisible()

		await expect
			.poll(() => eventsNamed(events, 'workspace_session_start').length, { timeout: 5000 })
			.toBe(1)
		expect(eventsNamed(events, 'fyp_opened_first')).toHaveLength(1)
		expect(eventsNamed(events, 'fyp_session_opened')).toHaveLength(1)
		expect(eventsNamed(events, 'workspace_session_start')[0]).toMatchObject({
			workspace_id: account.workspaceId,
		})
	})

	test('fyp_briefing_read fires from the card body scrolling past 50%', async ({
		page,
		account,
	}) => {
		const events = collectAnalytics(page)
		await mockBriefingRoutes(page, BRIEFING_ID, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('briefing-card')).toBeVisible()

		// Card renders below the viewport fold; scroll the body into view to
		// cross the 50%-intersection threshold. Two-phase scroll ensures the
		// IntersectionObserver ticks even under coarse scheduling.
		await page.getByTestId('briefing-body').scrollIntoViewIfNeeded()
		await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'auto' }))

		await expect
			.poll(() => eventsNamed(events, 'fyp_briefing_read').length, { timeout: 5000 })
			.toBe(1)
		expect(eventsNamed(events, 'fyp_briefing_read')[0]).toMatchObject({
			entity_id: BRIEFING_ID,
			entity_type: 'knowledge',
		})
	})

	test('fyp_briefing_audio_played fires when the audio playhead crosses 60s', async ({
		page,
		account,
	}) => {
		const events = collectAnalytics(page)
		await mockBriefingRoutes(page, BRIEFING_ID, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('briefing-card')).toBeVisible()

		// Synthesise a timeupdate at t=61s on the audio element — the card's
		// inline timeupdate handler reads currentTime, so patch that and
		// dispatch. Avoids waiting on real audio playback in the harness.
		await page.evaluate(() => {
			const el = document.querySelector<HTMLAudioElement>('[data-testid="briefing-audio"]')
			if (!el) throw new Error('briefing-audio element not found')
			Object.defineProperty(el, 'currentTime', { configurable: true, get: () => 61 })
			el.dispatchEvent(new Event('timeupdate'))
		})

		await expect
			.poll(() => eventsNamed(events, 'fyp_briefing_audio_played').length, { timeout: 5000 })
			.toBe(1)
		expect(eventsNamed(events, 'fyp_briefing_audio_played')[0]).toMatchObject({
			entity_id: BRIEFING_ID,
			entity_type: 'knowledge',
		})
	})

	test('session + briefing events dedupe across a within-tab reload', async ({ page, account }) => {
		const events = collectAnalytics(page)
		await mockBriefingRoutes(page, BRIEFING_ID, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('briefing-card')).toBeVisible()

		// Fire the briefing_read for BRIEFING_ID.
		await page.getByTestId('briefing-body').scrollIntoViewIfNeeded()
		await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'auto' }))
		await expect
			.poll(() => eventsNamed(events, 'fyp_briefing_read').length, { timeout: 5000 })
			.toBe(1)

		// Reload keeps sessionStorage — dedupes must hold for both session events
		// and the just-fired briefing_read on the same briefingId.
		await page.reload()
		await expect(page.getByTestId('briefing-card')).toBeVisible()
		await page.getByTestId('briefing-body').scrollIntoViewIfNeeded()
		await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'auto' }))
		await page.waitForTimeout(500)

		expect(eventsNamed(events, 'workspace_session_start')).toHaveLength(1)
		expect(eventsNamed(events, 'fyp_opened_first')).toHaveLength(1)
		expect(eventsNamed(events, 'fyp_session_opened')).toHaveLength(1)
		expect(eventsNamed(events, 'fyp_briefing_read')).toHaveLength(1)
	})

	test('fyp_briefing_read fires again for a different briefing_id in the same session', async ({
		page,
		account,
	}) => {
		const events = collectAnalytics(page)
		await mockBriefingRoutes(page, BRIEFING_ID, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)
		await page.getByTestId('briefing-body').scrollIntoViewIfNeeded()
		await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'auto' }))
		await expect
			.poll(() => eventsNamed(events, 'fyp_briefing_read').length, { timeout: 5000 })
			.toBe(1)

		// Swap the mocked briefing to a fresh id — a new CoS-authored briefing
		// coming through SSE invalidation. The dedupe key is per-briefing so the
		// read should re-fire.
		await page.unroute('**/api/briefing/latest*')
		await mockBriefingRoutes(page, BRIEFING_ID_ALT, account.workspaceId)
		await page.reload()
		await expect(page.getByTestId('briefing-card')).toBeVisible()
		await page.getByTestId('briefing-body').scrollIntoViewIfNeeded()
		await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'auto' }))

		await expect
			.poll(() => eventsNamed(events, 'fyp_briefing_read').length, { timeout: 5000 })
			.toBe(2)
		expect(eventsNamed(events, 'fyp_briefing_read')[1]).toMatchObject({
			entity_id: BRIEFING_ID_ALT,
		})
	})
})
