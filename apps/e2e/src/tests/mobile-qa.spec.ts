import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { type NamedViewport, SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1

// The wide-content payloads that catch the two shapes from the 4917d6f3
// regression: a six-column markdown table (rendered by the non-own path) and a
// single unbroken URL (rendered by the own path). Together they cover the two
// message bubble branches and both are wider than the mobile viewport.
const WIDE_TABLE = [
	'| Signal | Segment | Owner | Confidence | Evidence | Next check |',
	'| --- | --- | --- | --- | --- | --- |',
	'| Enterprise onboarding drop-off | Self-serve mid-market accounts | Release Verifier | 0.62 | Step 2 abandons at 3x the baseline rate across every activation cohort this quarter | Re-run the cohort split once the next deploy lands |',
].join('\n')
const LONG_UNBROKEN_URL =
	'https://internal.example.com/reports/2026/09/enterprise-onboarding-dropoff-cohort-split-by-activation-source-seat-count'

async function assertNoHorizontalOverflow(page: Page, surface: string, viewport: NamedViewport) {
	// `load` instead of `networkidle` — the app holds an SSE connection to /api/events,
	// so networkidle never fires. Brief layout-settle wait after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(200)

	const report = await page.evaluate(
		({ tolerance }) => {
			const innerWidth = window.innerWidth
			const describe = (el: Element) => {
				const testId = el.getAttribute('data-testid')
				if (testId) return `[data-testid="${testId}"]`
				const id = el.id ? `#${el.id}` : ''
				const cls =
					typeof el.className === 'string' && el.className
						? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
						: ''
				return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 160)
			}

			// The assertion fires when an element's own content is wider than its box
			// AND the source did not declare any horizontal-overflow intent. Two
			// intent categories are legitimate — both mean "the developer asked for
			// this shape, not a silent clip":
			//   1. Horizontal scroller: `overflow-x-auto|scroll`, `overflow-auto`, or
			//      inline `overflow-x: auto|scroll`. The user can pan the content.
			//   2. Explicit clip: Tailwind `sr-only` (a11y hide, 1×1 box on purpose),
			//      `truncate` (single-line ellipsis, `overflow: hidden`), `line-clamp-*`
			//      (multi-line ellipsis), `overflow-hidden`, `overflow-x-hidden`, or
			//      inline `overflow-x: hidden` / `overflow: hidden`. The clip IS the
			//      feature.
			// Computed overflow is not enough on its own — per CSS spec, `overflow-y:
			// auto` alone makes `overflow-x` compute to `auto`, which is exactly why
			// the chats thread scroller (`data-testid="thread-messages"`, source class
			// `overflow-y-auto`) silently swallowed the 4917d6f3 regression while
			// looking like a legitimate horizontal scroller. Reading source-level
			// intent (the class list or an inline style) is what separates "developer
			// asked for this" from "a vertical-primary container silently accepted an
			// `auto` overflow-x it never wanted".
			const HORIZONTAL_SCROLL_INTENT_TOKENS = [
				'overflow-x-auto',
				'overflow-x-scroll',
				'overflow-auto',
			]
			const HORIZONTAL_CLIP_INTENT_TOKENS = [
				'sr-only',
				'truncate',
				'overflow-hidden',
				'overflow-x-hidden',
			]
			const hasHorizontalOverflowIntent = (el: Element) => {
				const inlineOverflowX = (el as HTMLElement).style?.overflowX
				if (
					inlineOverflowX === 'auto' ||
					inlineOverflowX === 'scroll' ||
					inlineOverflowX === 'hidden'
				) {
					return true
				}
				const inlineOverflow = (el as HTMLElement).style?.overflow
				if (inlineOverflow === 'hidden') return true
				if (typeof el.className === 'string') {
					const classes = el.className.trim().split(/\s+/)
					for (const cls of classes) {
						if (HORIZONTAL_SCROLL_INTENT_TOKENS.includes(cls)) return true
						if (HORIZONTAL_CLIP_INTENT_TOKENS.includes(cls)) return true
						// Tailwind `line-clamp-1`, `line-clamp-2`, … all set
						// `overflow: hidden` for multi-line ellipsis.
						if (cls.startsWith('line-clamp-')) return true
					}
				}
				return false
			}

			const FORM_FIELD_TAGS = ['INPUT', 'TEXTAREA', 'SELECT']

			const offenders: {
				selector: string
				scrollWidth: number
				clientWidth: number
			}[] = []

			// Skip <html> and <body> — the document-level check below covers those.
			// Every other element that reports more scrollable content than its own
			// client box (and was not tagged as an intended horizontal scroller) is
			// silently clipping or unintentionally horizontally scrolling — the exact class
			// of failure that reached `main` in #1700.
			for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
				if (el.scrollWidth <= el.clientWidth + tolerance) continue
				// An input's scrollWidth is its text width, not its layout box: it
				// changes with the typed or placeholder text (343 to 381 across the
				// Settings index retries) while clientWidth stays fixed.
				if (FORM_FIELD_TAGS.includes(el.tagName)) continue
				if (hasHorizontalOverflowIntent(el)) continue
				offenders.push({
					selector: describe(el),
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
				})
			}

			return {
				innerWidth,
				docScrollWidth: document.documentElement.scrollWidth,
				offenders,
			}
		},
		{ tolerance: HORIZONTAL_OVERFLOW_TOLERANCE_PX },
	)

	// Document-level check — kept, because `overflow-x: clip` on html/body in
	// `apps/web/src/app.css` is the reason inner overflow can hide from this
	// check today, and a future revert of that rule must still fail the gate.
	// Soft assertions: the surface loop keeps walking after a failure, so one run
	// lists every offending surface instead of stopping at the first. The test
	// still fails at the end.
	expect
		.soft(
			report.docScrollWidth,
			`${surface} document overflows horizontally at ${viewport.label}: scrollWidth=${report.docScrollWidth} > innerWidth=${report.innerWidth}`,
		)
		.toBeLessThanOrEqual(report.innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)

	// Inner-scroller check — flags any element whose own scrollWidth exceeds its
	// clientWidth without an explicit horizontal-scroll intent in the source.
	// This is what asserts the chats thread scroller (and any other future
	// vertical-primary container) actually contains its content.
	expect
		.soft(
			report.offenders,
			`${surface} has inner-scroller horizontal overflow at ${viewport.label} (innerWidth=${report.innerWidth}): ${JSON.stringify(report.offenders)}`,
		)
		.toEqual([])
}

// Critical controls that must remain visible at every ship-gate viewport on the
// For You → object → comment surface. The horizontal-overflow gate caught
// layout regressions but missed "control is rendered transparently" or
// "control was hidden behind a hover-only modifier on a touch device" — both
// of which silently fail the parity constraint ("no functionality hidden on
// iPad"). Each control is asserted by its accessible role/name + the
// Playwright `toBeVisible` opacity check (ignores opacity:0 and visibility:hidden).
async function assertCommentComposerVisible(page: Page, surface: string, viewport: NamedViewport) {
	const composer = page.getByRole('textbox', { name: 'Comment' }).first()
	await expect(
		composer,
		`${surface}: comment composer must be visible at ${viewport.label}`,
	).toBeVisible({ timeout: 5000 })
}

interface Surface {
	name: string
	path: (workspaceId: string, ids: SeedIds) => string
	waitFor?: (page: Page) => Promise<void>
}

interface SeedIds {
	betId: string
	insightId: string
	taskId: string
	conversationId: string
}

const CHAT_CONVERSATION_TITLE = 'Mobile QA Chat'

const SURFACES: Surface[] = [
	{
		name: 'For You (workspace landing)',
		path: (ws) => `/${ws}`,
	},
	{
		name: 'Objects list',
		path: (ws) => `/${ws}/objects`,
		waitFor: async (page) => {
			await page.waitForLoadState('load')
		},
	},
	{
		name: 'Object detail (bet)',
		path: (ws, ids) => `/${ws}/objects/${ids.betId}`,
		waitFor: async (page) => {
			await expect(page.getByRole('heading', { level: 1, name: 'Mobile QA Bet' })).toBeVisible({
				timeout: 10000,
			})
		},
	},
	{
		name: 'Object detail (insight)',
		path: (ws, ids) => `/${ws}/objects/${ids.insightId}`,
	},
	{
		name: 'Object detail (task)',
		path: (ws, ids) => `/${ws}/objects/${ids.taskId}`,
	},
	{
		name: 'Chats list',
		path: (ws) => `/${ws}/chats`,
		waitFor: async (page) => {
			await expect(page.getByRole('link', { name: CHAT_CONVERSATION_TITLE }).first()).toBeVisible({
				timeout: 10000,
			})
		},
	},
	{
		name: 'Chat detail (wide table + long URL)',
		path: (ws, ids) => `/${ws}/chats/${ids.conversationId}`,
		waitFor: async (page) => {
			await expect(page.getByRole('heading', { name: CHAT_CONVERSATION_TITLE })).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByTestId('thread-messages')).toBeVisible({ timeout: 10000 })
		},
	},
	{
		name: 'Agents list',
		path: (ws) => `/${ws}/agents`,
	},
	{
		name: 'Triggers list',
		path: (ws) => `/${ws}/triggers`,
	},
	{
		name: 'Settings index',
		path: (ws) => `/${ws}/settings`,
	},
	{
		name: 'Settings — objects',
		path: (ws) => `/${ws}/settings/objects`,
	},
	{
		name: 'Settings — members',
		path: (ws) => `/${ws}/settings/members`,
	},
	{
		name: 'Settings — keys',
		path: (ws) => `/${ws}/settings/keys`,
	},
	{
		name: 'Settings — integrations',
		path: (ws) => `/${ws}/settings/integrations`,
	},
	{
		name: 'Settings — MCP',
		path: (ws) => `/${ws}/settings/mcp`,
	},
	{
		name: 'Settings — skills',
		path: (ws) => `/${ws}/settings/skills`,
	},
]

async function seedObjects(account: {
	workspaceId: string
	api: TestAPI
}): Promise<SeedIds> {
	const bet = await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Mobile QA Bet',
		status: 'opportunity',
	})
	const insight = await account.api.createObject(account.workspaceId, {
		type: 'insight',
		title: 'Mobile QA Insight',
		status: 'new',
	})
	const task = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Mobile QA Task',
		status: 'todo',
	})

	// A conversation carrying both regression shapes. The wide markdown table is
	// posted by a SECOND, non-own agent — MessageBubble forks on isOwn and only
	// the non-own branch emits <table>, so seeding it from the session actor
	// leaves the markdown path unexercised (this is the exact seeding mistake
	// PR #1700 fixed in `chat-detail-overflow.spec.ts`). The long unbroken URL
	// is posted by the session actor, exercising the plain-text bubble that
	// `break-words` must contain.
	const stamp = Date.now()
	const agent = await account.api.createAgentActor(`Mobile QA Chat Agent ${stamp}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: CHAT_CONVERSATION_TITLE,
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	const agentApi = new TestAPI(agent.api_key)
	await agentApi.postConversationMessage(conversation.id, account.workspaceId, {
		content: WIDE_TABLE,
	})
	await account.api.postConversationMessage(conversation.id, account.workspaceId, {
		content: LONG_UNBROKEN_URL,
	})

	return {
		betId: bet.id,
		insightId: insight.id,
		taskId: task.id,
		conversationId: conversation.id,
	}
}

test.describe('Mobile + iPad QA — viewport overflow ship gate', () => {
	// Brief: every surface must pass the viewport-overflow check at 375 / 768 / 1024.
	// Any horizontal scroll at a ship-gate viewport fails the surface.
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`no horizontal overflow on any surface @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const ids = await seedObjects(account)

			for (const surface of SURFACES) {
				await page.goto(surface.path(account.workspaceId, ids))
				if (surface.waitFor) await surface.waitFor(page)
				await assertNoHorizontalOverflow(page, surface.name, viewport)
			}
		})
	}
})

test.describe('Mobile + iPad QA — critical controls ship gate', () => {
	// Brief: at every ship-gate viewport (375 / 768 / 1024), the comment composer
	// must be visible on object detail. The horizontal-overflow gate caught
	// layout regressions but missed cases where a control was rendered with
	// opacity:0 and a hover-only reveal — invisible on touch devices like iPad
	// portrait. Asserting accessible-role visibility here catches "functionality
	// hidden on iPad" before it ships.
	//
	// The reply-to-thread button renders only on root comments in a thread — the
	// activity timeline is T2 scope, so the T1 surface must show the composer
	// and must NOT render a dead Reply affordance (pinned as an absence
	// contract; the reply path returns with the timeline).
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`composer visible, no dead Reply affordance on object detail @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const ids = await seedObjects(account)

			await page.goto(`/${account.workspaceId}/objects/${ids.betId}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Mobile QA Bet' })).toBeVisible({
				timeout: 10000,
			})

			await assertCommentComposerVisible(page, 'Object detail', viewport)
			await expect(page.getByRole('button', { name: 'Reply' })).toHaveCount(0)
		})
	}
})

test.describe('Mobile first-test flow — For You → object → comment', () => {
	test('walks the bet first-test flow at 375px without horizontal overflow', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})
		const ids = await seedObjects(account)

		// 1. For You — workspace landing
		await page.goto(`/${account.workspaceId}`)
		await assertNoHorizontalOverflow(page, 'For You (step 1)', VIEWPORTS.mobile)

		// 2. Object detail — drive directly to the seeded bet (no unread thread is required;
		//    the brief's flow is "land → object → comment" and the unread feed depends on
		//    cross-actor activity that this single-actor fixture can't synthesize).
		await page.goto(`/${account.workspaceId}/objects/${ids.betId}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Mobile QA Bet' })).toBeVisible({
			timeout: 10000,
		})
		await assertNoHorizontalOverflow(page, 'Object detail (step 2)', VIEWPORTS.mobile)

		// 3. Comment — type and send via the composer. The activity timeline is
		//    T2 scope, so the send is confirmed by the composer clearing (the
		//    posted comment row itself returns with the timeline).
		const composer = page.getByRole('textbox', { name: 'Comment' })
		await composer.click()
		await composer.fill('QA comment from mobile')
		await page.getByRole('button', { name: 'Send comment' }).click()
		await expect(composer).toHaveText('', { timeout: 10000 })
		await assertNoHorizontalOverflow(page, 'Object detail after comment (step 3)', VIEWPORTS.mobile)
	})
})

test.describe('Desktop regression — same surfaces at 1440', () => {
	test('no horizontal overflow on any surface @ Desktop (1440×900)', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		const ids = await seedObjects(account)

		for (const surface of SURFACES) {
			await page.goto(surface.path(account.workspaceId, ids))
			if (surface.waitFor) await surface.waitFor(page)
			await assertNoHorizontalOverflow(page, surface.name, VIEWPORTS.desktop)
		}
	})
})

// A long plain-text message with blank lines, so the thread has to wrap and
// scroll it instead of clipping it (the markdown table and URL above cover the
// wide shapes; this one covers the tall shape).
const LONG_MESSAGE = Array.from(
	{ length: 14 },
	(_, i) =>
		`Paragraph ${i + 1}: who has a reason to care right now, then send a short, credible, human message. That is consistent with older sales guidance, but the 2026 environment adds a much bigger emphasis on intent, deliverability, and relevance.`,
).join('\n\n')

// iPhone portrait with a Dynamic Island and a home indicator.
const SAFE_AREA = { top: 59, bottom: 34 }

test.describe('Mobile chat — long content, send button and safe areas @ 375', () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		// Chromium cannot reproduce Safari's insets on its own; this override makes
		// env(safe-area-inset-*) report the iPhone values.
		const cdp = await page.context().newCDPSession(page)
		await cdp.send('Emulation.setSafeAreaInsetsOverride', {
			insets: { top: SAFE_AREA.top, bottom: SAFE_AREA.bottom, left: 0, right: 0 },
		})
	})

	async function seedLongThread(account: { workspaceId: string; api: TestAPI }) {
		const stamp = Date.now()
		const agent = await account.api.createAgentActor(`Mobile QA Long Agent ${stamp}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Mobile QA Long Chat',
			participant_actor_ids: [agent.id],
			initial_message: 'Opening the thread',
		})
		await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
			content: LONG_MESSAGE,
		})
		return conversation.id
	}

	async function assertComposerAndHeaderFit(page: Page, surface: string) {
		const send = page.getByRole('button', { name: 'Send message' })
		await expect(send, `${surface}: send button must be visible`).toBeVisible()
		const box = await send.boundingBox()
		const viewport = page.viewportSize()
		if (!box || !viewport) throw new Error(`${surface}: no layout box for the send button`)
		expect(box.y, `${surface}: send button top inside the viewport`).toBeGreaterThanOrEqual(0)
		// The home indicator sits in the bottom inset, so the button must clear it.
		expect(
			box.y + box.height,
			`${surface}: send button must sit above the bottom safe area`,
		).toBeLessThanOrEqual(viewport.height - SAFE_AREA.bottom)
		expect(
			box.x + box.width,
			`${surface}: send button right edge inside the viewport`,
		).toBeLessThanOrEqual(viewport.width)

		const headerBox = await page.locator('header').first().boundingBox()
		const titleBox = await page.locator('header h1').first().boundingBox()
		expect(headerBox, `${surface}: header has a layout box`).not.toBeNull()
		expect(
			titleBox?.y ?? 0,
			`${surface}: top bar content must start below the status bar and system icons`,
		).toBeGreaterThanOrEqual(SAFE_AREA.top)
	}

	async function assertTextareaCapped(page: Page, surface: string) {
		const textarea = page.getByLabel('Message this conversation')
		await textarea.fill(LONG_MESSAGE)
		const metrics = await textarea.evaluate((el) => ({
			fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
			height: el.getBoundingClientRect().height,
			scrollHeight: el.scrollHeight,
			overflowY: getComputedStyle(el).overflowY,
		}))
		// 16px is iOS Safari's no-zoom-on-focus floor.
		expect(metrics.fontSize, `${surface}: composer font size`).toBeGreaterThanOrEqual(16)
		// Grows to a cap, then scrolls inside itself.
		expect(metrics.height, `${surface}: composer stops growing at its cap`).toBeLessThanOrEqual(200)
		expect(
			metrics.scrollHeight,
			`${surface}: long text is taller than the capped box`,
		).toBeGreaterThan(metrics.height)
		expect(metrics.overflowY, `${surface}: composer scrolls inside itself`).toMatch(/auto|scroll/)
	}

	test('chat thread: long message wraps, long composer text keeps send visible', async ({
		page,
		account,
	}) => {
		const conversationId = await seedLongThread(account)
		await page.goto(`/${account.workspaceId}/chats/${conversationId}`)
		const thread = page.getByTestId('thread-messages')
		await expect(thread).toBeVisible({ timeout: 10000 })
		await expect(thread.getByText('Paragraph 14:')).toBeAttached({ timeout: 10000 })

		// The long message must wrap inside the scroller: nothing wider than the
		// box, and the scroller itself (not the page) carries the extra height.
		const scroller = await thread.evaluate((el) => ({
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}))
		expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1)
		expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
		await assertNoHorizontalOverflow(page, 'Chat thread (long message)', VIEWPORTS.mobile)

		await assertTextareaCapped(page, 'Chat thread')
		await assertComposerAndHeaderFit(page, 'Chat thread (long composer text)')
	})

	test('new chat: recipient list stays small, long composer text keeps send visible', async ({
		page,
		account,
	}) => {
		for (let i = 0; i < 6; i++) {
			const agent = await account.api.createAgentActor(`Mobile QA Pick Agent ${Date.now()}-${i}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		}
		await page.goto(`/${account.workspaceId}/chats/new`)
		await page.getByLabel('Add recipients').click()
		const list = page.getByRole('listbox')
		await expect(list).toBeVisible({ timeout: 10000 })
		const listBox = await list.boundingBox()
		// A fixed, small share of an 812px screen: at most 4 rows (160px).
		expect(listBox?.height ?? 0).toBeLessThanOrEqual(160 + 1)

		await page.keyboard.press('Escape')
		await assertTextareaCapped(page, 'New chat')
		await assertComposerAndHeaderFit(page, 'New chat (long composer text)')
	})
})
