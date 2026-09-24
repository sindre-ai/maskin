import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { type NamedViewport, SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Regression gate for horizontal content overflow on the chat detail surface
 * (/$workspaceId/chats/$conversationId).
 *
 * The defect this pins: a wide descendant (a markdown table, a long unbroken
 * URL) widened the thread column past the phone's right edge. Three
 * silent-clip ancestors swallowed the symptom — SidebarInset's
 * overflow-hidden, the scroll area's overflow-hidden while the route holds
 * scrollLocked, and `html, body { overflow-x: clip }` — so
 * documentElement.scrollWidth stayed 375px while the column was 453px. A
 * scrollWidth-only gate therefore does NOT catch this class; these tests walk
 * the ancestor chain above the composer and fail on any node that sticks out
 * of the viewport without being a real scroll container. The fix is
 * `min-w-0` on the thread column — see the comment at that line in
 * apps/web/src/routes/_authed/$workspaceId/chats/$conversationId.tsx.
 *
 * Requires a live backend — the conversation and its wide content are seeded
 * through the real /api/conversations routes (TestAPI), not mocked.
 */

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1

const CONVERSATION_TITLE = 'Overflow QA Chat'

// Six columns of deliberately long cells. The table's intrinsic width exceeds
// every ship-gate viewport, which is what forced the pre-fix blow-out.
const WIDE_TABLE = [
	'| Signal | Segment | Owner | Confidence | Evidence | Next check |',
	'| --- | --- | --- | --- | --- | --- |',
	'| Enterprise onboarding drop-off | Self-serve mid-market accounts | Release Verifier | 0.62 | Step 2 abandons at 3x the baseline rate across every activation cohort this quarter | Re-run the cohort split once the next deploy lands |',
].join('\n')

// A single unbroken token — no whitespace for the line-breaking algorithm to
// use, so it can only be contained by a bounded ancestor width.
const LONG_UNBROKEN_URL =
	'https://internal.example.com/reports/2026/09/enterprise-onboarding-dropoff-cohort-split-by-activation-source-seat-count'

interface OverflowAccount {
	workspaceId: string
	api: TestAPI
}

async function seedOverflowConversation(account: OverflowAccount): Promise<{ id: string }> {
	// The creator is added as a participant automatically, so an empty list is
	// a valid single-participant conversation — no second seat needed.
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: CONVERSATION_TITLE,
		participant_actor_ids: [],
		initial_message: WIDE_TABLE,
	})
	await account.api.postConversationMessage(conversation.id, account.workspaceId, {
		content: LONG_UNBROKEN_URL,
	})
	return conversation
}

async function openConversation(page: Page, account: OverflowAccount): Promise<{ id: string }> {
	const conversation = await seedOverflowConversation(account)
	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	await expect(page.getByRole('heading', { name: CONVERSATION_TITLE })).toBeVisible({
		timeout: 10_000,
	})
	return conversation
}

/**
 * Fails if any ancestor of the composer — up to but excluding the root
 * element — extends past the viewport while not being a genuine scroll
 * container (overflow-x auto/scroll). Nodes inside an `overflow-x: auto` box
 * (the markdown table wrapper) are the intended contained-scroll case and are
 * excluded; a node that is merely `overflow-x: hidden`/`clip` and sticks out
 * is exactly the silent-clip failure and IS reported.
 */
async function assertChatColumnContained(page: Page, viewport: NamedViewport) {
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief layout-settle wait.
	await page.waitForLoadState('load')
	await page.waitForTimeout(200)

	const composer = page.getByLabel('Message this conversation').first()
	await expect(composer, `chat composer must be visible at ${viewport.label}`).toBeVisible({
		timeout: 10_000,
	})

	const handle = await composer.elementHandle()
	expect(handle, 'chat composer handle must resolve').not.toBeNull()

	const report = await page.evaluate((el: HTMLElement | SVGElement | null) => {
		// page.evaluate takes only one serializable argument alongside the element
		// handle, so the tolerance is mirrored here — keep in step with
		// HORIZONTAL_OVERFLOW_TOLERANCE_PX.
		const tolerance = 1
		const innerWidth = window.innerWidth
		const offenders: {
			selector: string
			left: number
			right: number
			overflowX: string
		}[] = []

		const describe = (node: Element) => {
			const id = node.id ? `#${node.id}` : ''
			const cls =
				typeof node.className === 'string' && node.className
					? `.${node.className.trim().split(/\s+/).join('.')}`
					: ''
			return `${node.tagName.toLowerCase()}${id}${cls}`.slice(0, 160)
		}

		let node: Element | null = el
		while (node && node !== document.documentElement) {
			const rect = node.getBoundingClientRect()
			const overflowX = getComputedStyle(node).overflowX
			const sticksOut = rect.right > innerWidth + tolerance || rect.left < -tolerance
			const scrolls = overflowX === 'auto' || overflowX === 'scroll'
			if (sticksOut && !scrolls) {
				offenders.push({
					selector: describe(node),
					left: Math.round(rect.left),
					right: Math.round(rect.right),
					overflowX,
				})
			}
			node = node.parentElement
		}

		return {
			innerWidth,
			docScrollWidth: document.documentElement.scrollWidth,
			bodyScrollWidth: document.body.scrollWidth,
			offenders,
		}
	}, handle)

	expect(
		report.offenders,
		`chat detail has uncontained horizontal overflow at ${viewport.label} ` +
			`(viewport ${report.innerWidth}px): ${JSON.stringify(report.offenders)}`,
	).toEqual([])

	expect(
		report.docScrollWidth,
		`chat detail documentElement.scrollWidth=${report.docScrollWidth} exceeds ` +
			`innerWidth=${report.innerWidth} at ${viewport.label}`,
	).toBeLessThanOrEqual(report.innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)

	expect(
		report.bodyScrollWidth,
		`chat detail body.scrollWidth=${report.bodyScrollWidth} exceeds ` +
			`innerWidth=${report.innerWidth} at ${viewport.label}`,
	).toBeLessThanOrEqual(report.innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)
}

/**
 * The wide table must be reachable and contained: rendered visible, sitting
 * inside an `overflow-x: auto` wrapper that is itself inside the viewport.
 * This is the positive half of the gate — "no overflow" alone could also be
 * satisfied by clipping the content away entirely.
 */
async function assertWideTableContained(page: Page, viewport: NamedViewport) {
	const table = page.locator('[data-testid="thread-messages"] table').first()
	await expect(table, `markdown table must render in the thread at ${viewport.label}`).toBeVisible({
		timeout: 10_000,
	})

	const report = await page.evaluate((tolerance) => {
		const table = document.querySelector('[data-testid="thread-messages"] table')
		if (!table) return null
		const wrapper = table.parentElement
		if (!wrapper) return null
		const rect = wrapper.getBoundingClientRect()
		return {
			overflowX: getComputedStyle(wrapper).overflowX,
			left: Math.round(rect.left),
			right: Math.round(rect.right),
			clientWidth: wrapper.clientWidth,
			scrollWidth: wrapper.scrollWidth,
			innerWidth: window.innerWidth,
			tolerance,
		}
	}, HORIZONTAL_OVERFLOW_TOLERANCE_PX)

	expect(report, 'markdown table wrapper must be found').not.toBeNull()
	if (!report) return

	expect(
		report.overflowX,
		`markdown table wrapper must own the horizontal scroll (overflow-x) at ${viewport.label}`,
	).toBe('auto')
	expect(
		report.left,
		`markdown table wrapper left edge ${report.left} is outside the viewport at ${viewport.label}`,
	).toBeGreaterThanOrEqual(-HORIZONTAL_OVERFLOW_TOLERANCE_PX)
	expect(
		report.right,
		`markdown table wrapper right edge ${report.right} exceeds innerWidth=${report.innerWidth} at ${viewport.label}`,
	).toBeLessThanOrEqual(report.innerWidth + report.tolerance)
	// The table is wider than its wrapper at the narrow viewports (so the
	// wrapper genuinely scrolls) and narrower at 1024 — both are contained.
	expect(report.scrollWidth).toBeGreaterThanOrEqual(report.clientWidth)
}

test.describe('Chat detail — horizontal overflow gate', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`wide markdown table and long URL stay inside the viewport @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openConversation(page, account)

			await assertChatColumnContained(page, viewport)
			await assertWideTableContained(page, viewport)
		})
	}

	test('composer still sends after the layout is exercised with wide content @ iPhone (375×812)', async ({
		page,
		account,
	}) => {
		const viewport = VIEWPORTS.mobile
		await page.setViewportSize({ width: viewport.width, height: viewport.height })
		await openConversation(page, account)
		await assertChatColumnContained(page, viewport)

		// The long unbroken URL is the second seeded message — assert it actually
		// rendered rather than being clipped out of existence.
		await expect(page.getByTestId('thread-messages')).toContainText(LONG_UNBROKEN_URL, {
			timeout: 10_000,
		})

		const messageText = `Overflow QA reply ${Date.now()}`
		const composer = page.getByLabel('Message this conversation').first()
		await composer.fill(messageText)
		await composer.press('Enter')

		await expect(page.getByTestId('thread-messages').getByText(messageText)).toBeVisible({
			timeout: 10_000,
		})

		// Sending must not reintroduce overflow.
		await assertChatColumnContained(page, viewport)
	})

	test('chat detail stays contained in dark mode @ iPhone (375×812)', async ({ page, account }) => {
		const viewport = VIEWPORTS.mobile
		await page.setViewportSize({ width: viewport.width, height: viewport.height })
		await page.emulateMedia({ colorScheme: 'dark' })
		await openConversation(page, account)

		await assertChatColumnContained(page, viewport)
		await assertWideTableContained(page, viewport)
	})
})
