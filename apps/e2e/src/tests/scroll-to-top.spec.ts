import { expect, test } from '../fixtures/auth.fixture'

// T1 event probe — drives the `scroll_to_top` emitter on a real bet page. CI
// runs without `VITE_POSTHOG_KEY`, so `posthog-js` is uninitialised and the
// `trackEvent` fallback logs `[analytics] scroll_to_top {...}` to the console
// instead of firing an XHR to `eu.i.posthog.com/e/`. We assert the console
// line — the payload shape is identical either way, so this proves the hook
// fires with the signed-off contract. Production emission is verified
// post-deploy via PostHog (see Ship Notes on the task).

test('scroll_to_top fires once with the signed-off schema after a full-viewport bounce', async ({
	page,
	account,
}) => {
	await page.setViewportSize({ width: 1024, height: 768 })

	const longBody = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. `.repeat(20)).join(
		'\n\n',
	)

	const bet = await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Scroll-to-top probe bet',
		content: longBody,
		status: 'active',
	})

	interface AnalyticsPayload {
		name: string
		entity_id?: string
		entity_type?: string
		object_subtype?: string
		scroll_depth_at_start_px?: number
		viewports_scrolled?: number
	}
	const analyticsCalls: AnalyticsPayload[] = []
	page.on('console', (msg) => {
		if (msg.type() !== 'info') return
		const args = msg.args()
		if (args.length < 2) return
		Promise.all(args.map((a) => a.jsonValue().catch(() => null)))
			.then((values) => {
				const [tag, payload] = values as [unknown, AnalyticsPayload | null]
				if (tag === '[analytics]' && payload && typeof payload === 'object') {
					analyticsCalls.push(payload)
				}
			})
			.catch(() => {})
	})

	await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
	await expect(page.locator('textarea').first()).toHaveValue('Scroll-to-top probe bet', {
		timeout: 10000,
	})

	const scrollRoot = page.locator('[data-scroll-root]')
	await expect(scrollRoot).toHaveCount(1)

	// Scroll ≥ 1 viewport down to arm, then all the way back to the top.
	await scrollRoot.evaluate((el) => {
		el.scrollTop = el.clientHeight * 2
	})
	await page.waitForTimeout(50)
	await scrollRoot.evaluate((el) => {
		el.scrollTop = 0
	})

	// Wait past the 250 ms settle window.
	await page.waitForTimeout(500)

	const scrollEvents = analyticsCalls.filter((c) => c.name === 'scroll_to_top')
	expect(scrollEvents).toHaveLength(1)
	expect(scrollEvents[0]).toMatchObject({
		name: 'scroll_to_top',
		entity_id: bet.id,
		entity_type: 'object',
		object_subtype: 'bet',
	})
	expect(scrollEvents[0].scroll_depth_at_start_px).toBeGreaterThanOrEqual(768)
	expect(scrollEvents[0].viewports_scrolled).toBeGreaterThanOrEqual(1)
})
