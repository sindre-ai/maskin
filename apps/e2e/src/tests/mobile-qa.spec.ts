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

	const report = await page.evaluate((tolerance: number) => {
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

		// A container is an *intentional* horizontal scroller only when the source
		// explicitly asked for it — an inline `overflow-x: auto|scroll` style or a
		// Tailwind `overflow-x-auto` / `overflow-x-scroll` class. Computed overflow
		// is not enough on its own: per CSS spec, `overflow-y: auto` alone makes
		// `overflow-x` compute to `auto`, which is exactly why the chats thread
		// scroller (`data-testid="thread-messages"`, source class `overflow-y-auto`)
		// silently swallowed the 4917d6f3 regression while looking like a
		// legitimate horizontal scroller.
		const HORIZONTAL_INTENT_TOKENS = ['overflow-x-auto', 'overflow-x-scroll', 'overflow-auto']
		const isIntendedHorizontalScroller = (el: Element) => {
			const inline = (el as HTMLElement).style?.overflowX
			if (inline === 'auto' || inline === 'scroll') return true
			if (typeof el.className === 'string') {
				for (const token of HORIZONTAL_INTENT_TOKENS) {
					if (el.className.includes(token)) return true
				}
			}
			return false
		}

		const offenders: {
			selector: string
			scrollWidth: number
			clientWidth: number
		}[] = []

		// Skip <html> and <body> — the document-level check below covers those.
		// Every other element that reports more scrollable content than its own
		// client box (and was not tagged as an intended horizontal scroller) is
		// silently clipping or unintentionally horizontally scrolling — the exact
		// class of failure that reached `main` in #1700.
		for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
			if (el.scrollWidth <= el.clientWidth + tolerance) continue
			if (isIntendedHorizontalScroller(el)) continue
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
	}, HORIZONTAL_OVERFLOW_TOLERANCE_PX)

	// Document-level check — kept, because `overflow-x: clip` on html/body in
	// `apps/web/src/app.css` is the reason inner overflow can hide from this
	// check today, and a future revert of that rule must still fail the gate.
	expect(
		report.docScrollWidth,
		`${surface} document overflows horizontally at ${viewport.label}: scrollWidth=${report.docScrollWidth} > innerWidth=${report.innerWidth}`,
	).toBeLessThanOrEqual(report.innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)

	// Inner-scroller check — flags any element whose own scrollWidth exceeds its
	// clientWidth without an explicit horizontal-scroll intent in the source.
	// This is what asserts the chats thread scroller (and any other future
	// vertical-primary container) actually contains its content.
	expect(
		report.offenders,
		`${surface} has inner-scroller horizontal overflow at ${viewport.label} (innerWidth=${report.innerWidth}): ${JSON.stringify(report.offenders)}`,
	).toEqual([])
}

// Critical controls that must remain visible at every ship-gate viewport on the
// For You → object → comment surface. The horizontal-overflow gate caught
// layout regressions but missed "control is rendered transparently" or
// "control was hidden behind a hover-only modifier on a touch device" — both
// of which silently fail the parity constraint ("no functionality hidden on
// iPad"). Each control is asserted by its accessible role/name + the
// Playwright `toBeVisible` opacity check (ignores opacity:0 and visibility:hidden).
// Both callers below are the object-detail surface, whose v2 shell passes its
// own placeholder down to the composer rather than using comment-input.tsx's
// default (object-detail-shell.tsx). The 768px split still mirrors
// useIsMobile() (apps/web/src/hooks/use-mobile.tsx), which is what the shell
// switches on.
function commentPlaceholderFor(viewport: NamedViewport): string {
	return viewport.width < 768 ? 'Comment…' : 'Comment — / commands, @ mentions'
}

async function assertCommentComposerVisible(page: Page, surface: string, viewport: NamedViewport) {
	const composer = page.getByPlaceholder(commentPlaceholderFor(viewport)).first()
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
		status: 'signal',
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
		const composer = page.getByPlaceholder(commentPlaceholderFor(VIEWPORTS.mobile))
		await composer.click()
		await composer.fill('QA comment from mobile')
		await page.getByRole('button', { name: 'Send comment' }).click()
		await expect(composer).toHaveValue('', { timeout: 10000 })
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
