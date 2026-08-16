import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Conversation view (T3 of bet `chats-list-conversation`).
//
// DoD:
//  1. On an open conversation the view renders the back control, title,
//     stacked participant avatars with overflow count.
//  2. The IN THIS CHAT panel renders participant rows with remove, an
//     add-someone search covering people and agents, copy-link,
//     invite-by-email, and the agent-explainer copy.
//  3. The loop context chip renders when the session carries a loop id.
//  4. The PICKING UP WHERE YOU LEFT OFF resume band renders.
//  5. Every control works and the surface stays reachable across 375–1024px.

interface MockSession {
	id: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	status: string
	containerId: string | null
	actionPrompt: string
	config: Record<string, unknown> | null
	result: Record<string, unknown> | null
	snapshotPath: string | null
	startedAt: string | null
	completedAt: string | null
	timeoutAt: string | null
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
	currentActivity: string | null
}

interface MockActor {
	id: string
	type: string
	name: string
	email: string | null
	description: string | null
	isSystem: boolean
	agentState: string
}

interface MockLoop {
	id: string
	workspaceId: string
	name: string
	guarantee: string | null
	status: 'running' | 'waiting' | 'paused' | 'archived'
	pill: 'running' | 'waiting_on_you' | 'paused' | 'archived'
	entryCondition: string | null
	closeCondition: string | null
	humanDecisionPoints: number | null
	inProgressCount: number
	closedCount: number
	medianTimeToCloseMs: number | null
	agentIds: string[]
	triggerIds: string[]
	waitingOnViewer: boolean
	createdAt: string | null
	updatedAt: string | null
}

const NOW = () => new Date().toISOString()

function buildSession(
	overrides: Partial<MockSession> & { id: string; actorId: string; actionPrompt: string },
): MockSession {
	const t = NOW()
	return {
		workspaceId: 'ws',
		triggerId: null,
		status: 'running',
		containerId: null,
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: t,
		completedAt: null,
		timeoutAt: null,
		createdBy: overrides.actorId,
		createdAt: t,
		updatedAt: t,
		currentActivity: null,
		...overrides,
	}
}

function buildActor(overrides: Partial<MockActor> & { id: string; name: string }): MockActor {
	return {
		type: 'agent',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'ready',
		...overrides,
	}
}

async function mockChatsData(
	page: Page,
	opts: { sessions: MockSession[]; actors: MockActor[]; loops?: MockLoop[] },
) {
	await page.route('**/api/sessions*', async (route) => {
		const url = new URL(route.request().url())
		const method = route.request().method()
		if (method === 'GET' && url.pathname.endsWith('/api/sessions')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(opts.sessions),
			})
			return
		}
		if (method === 'GET' && url.pathname.endsWith('/logs/stream')) {
			// SSE endpoint — return an empty text/event-stream so the client's
			// fetch-event-source polling doesn't fire real events into the test.
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: '',
			})
			return
		}
		if (method === 'GET' && url.pathname.endsWith('/logs')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: '[]',
			})
			return
		}
		if (method === 'POST' && url.pathname.endsWith('/input')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: '{"ok":true}',
			})
			return
		}
		if (method === 'GET') {
			// /api/sessions/:id — return the single row so a deep-link works.
			const id = url.pathname.split('/').pop() ?? ''
			const match = opts.sessions.find((s) => s.id === id)
			if (match) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(match),
				})
				return
			}
		}
		await route.fallback()
	})
	await page.route('**/api/actors*', async (route) => {
		const url = new URL(route.request().url())
		if (route.request().method() !== 'GET' || !url.pathname.endsWith('/api/actors'))
			return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(opts.actors),
		})
	})
	await page.route('**/api/notifications*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
	})
	await page.route('**/api/loops', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ loops: opts.loops ?? [] }),
		})
	})
}

async function expectNoHorizontalScroll(page: Page) {
	const overflow = await page.evaluate(() => {
		const doc = document.documentElement
		return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
	})
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
}

test.describe('Conversation view', () => {
	test('renders the header, participant stack, resume band and CoS attribution row', async ({
		page,
		account,
	}) => {
		const session = buildSession({
			id: 'sess-1',
			actorId: 'agent-cos',
			actionPrompt: 'Q3 retention drop — figure out where it is coming from',
			currentActivity: 'Pulling in Product Analyst for cohort math',
			config: { entry_agent_role: 'chief-of-staff' },
		})
		await mockChatsData(page, {
			sessions: [session],
			actors: [
				buildActor({ id: 'agent-cos', name: 'Chief of Staff' }),
				buildActor({ id: 'agent-analyst', name: 'Product Analyst' }),
			],
		})

		await page.goto(`/${account.workspaceId}/chats/${session.id}`)

		const view = page.getByTestId('chat-conversation-view')
		await expect(view).toBeVisible()
		await expect(view.getByRole('heading', { level: 1 })).toContainText('Q3 retention drop')
		await expect(view.getByText('Chief of Staff', { exact: true }).first()).toBeVisible()
		await expect(view.getByText('Default agent')).toBeVisible()

		// Resume band with recent-activity summary.
		await expect(view.getByRole('region', { name: /picking up where you left off/i })).toBeVisible()
		await expect(view.getByText(/pulling in product analyst/i)).toBeVisible()

		// Composer prefix routes to Chief of Staff.
		await expect(view.getByText(/replying to/i)).toBeVisible()
		await expect(view.getByText(/she'll route it/i)).toBeVisible()
	})

	test('IN THIS CHAT panel add/remove, copy-link, invite work', async ({ page, account }) => {
		const session = buildSession({
			id: 'sess-2',
			actorId: 'agent-cos',
			actionPrompt: 'Draft the Q4 kickoff note',
			config: { entry_agent_role: 'chief-of-staff' },
		})
		await mockChatsData(page, {
			sessions: [session],
			actors: [
				buildActor({ id: 'agent-cos', name: 'Chief of Staff' }),
				buildActor({ id: 'agent-marketer', name: 'Marketer' }),
			],
		})

		// Grant clipboard permission and stub writeText so we can assert the
		// URL passed through without needing browser-level clipboard access.
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
		await page.addInitScript(() => {
			;(window as unknown as { __copied: string | null }).__copied = null
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						;(window as unknown as { __copied: string }).__copied = text
					},
					readText: async () => (window as unknown as { __copied: string }).__copied ?? '',
				},
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${session.id}`)

		await page
			.getByRole('button', { name: /in this chat/i })
			.first()
			.click()

		// Locked CoS row is not removable.
		await expect(page.getByText(/routes your ask to the right specialist/i)).toBeVisible()

		// Add someone: search finds the marketer and adds them.
		const search = page.getByLabel('Search people and agents')
		await search.fill('mark')
		const marketerBtn = page.getByRole('button', { name: /marketer/i }).last()
		await marketerBtn.click()

		// Remove the newly added marketer via the remove button.
		const removeBtn = page.getByRole('button', { name: /remove marketer/i })
		await expect(removeBtn).toBeVisible()
		await removeBtn.click()
		await expect(page.getByRole('button', { name: /remove marketer/i })).toHaveCount(0)

		// Copy link.
		await page.getByRole('button', { name: /copy link/i }).click()
		await expect
			.poll(
				async () =>
					await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied),
			)
			.toContain(`/chats/${session.id}`)

		// Invite renders a mailto: link that carries the chat URL.
		const invite = page.getByRole('link', { name: /invite someone by email/i })
		const href = await invite.getAttribute('href')
		expect(href).toMatch(/^mailto:/)
		expect(href).toContain(encodeURIComponent(`/chats/${session.id}`))
	})

	test('loop context chip renders when the session carries a loop id', async ({
		page,
		account,
	}) => {
		const loopId = '11111111-1111-1111-1111-111111111111'
		const session = buildSession({
			id: 'sess-3',
			actorId: 'agent-cos',
			actionPrompt: 'Weekly launch review',
			config: { entry_agent_role: 'chief-of-staff', loop_id: loopId },
		})
		await mockChatsData(page, {
			sessions: [session],
			actors: [buildActor({ id: 'agent-cos', name: 'Chief of Staff' })],
			loops: [
				{
					id: loopId,
					workspaceId: 'ws',
					name: 'Launch loop',
					guarantee: null,
					status: 'running',
					pill: 'running',
					entryCondition: null,
					closeCondition: null,
					humanDecisionPoints: null,
					inProgressCount: 0,
					closedCount: 0,
					medianTimeToCloseMs: null,
					agentIds: [],
					triggerIds: [],
					waitingOnViewer: false,
					createdAt: null,
					updatedAt: null,
				},
			],
		})

		await page.goto(`/${account.workspaceId}/chats/${session.id}`)
		await expect(page.getByText('Launch loop')).toBeVisible()
	})
})

test.describe('Conversation view — transcript + composer wiring (T7)', () => {
	test('renders replayed transcript, activates the composer, and posts input', async ({
		page,
		account,
	}) => {
		const session = buildSession({
			id: 'sess-wired',
			actorId: 'agent-cos',
			actionPrompt: 'Kick off the plan',
			config: { entry_agent_role: 'chief-of-staff' },
		})
		await mockChatsData(page, {
			sessions: [session],
			actors: [buildActor({ id: 'agent-cos', name: 'Chief of Staff' })],
		})
		// Replay one assistant log line so the transcript shows something the
		// user could see loaded from history, not just the empty state.
		await page.route(`**/api/sessions/${session.id}/logs**`, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{
						id: 1,
						sessionId: session.id,
						stream: 'stdout',
						content: JSON.stringify({
							type: 'assistant',
							session_id: session.id,
							message: { id: 'msg-1', content: [{ type: 'text', text: 'Loaded history line' }] },
						}),
						createdAt: '2026-08-15T00:00:00Z',
					},
				]),
			})
		})

		let inputBody: unknown = null
		await page.route(`**/api/sessions/${session.id}/input`, async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			inputBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: '{"ok":true}',
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${session.id}`)

		// Replayed transcript is visible.
		await expect(page.getByText('Loaded history line')).toBeVisible()

		// Composer textarea and Send are enabled — no longer visually inert.
		const textarea = page.getByLabel('New message')
		await expect(textarea).toBeEnabled()
		const send = page.getByLabel('Send message')
		await expect(send).toBeDisabled()
		await textarea.fill('Ship it')
		await expect(send).toBeEnabled()
		await send.click()

		await expect.poll(() => (inputBody as { content?: string } | null)?.content).toBe('Ship it')

		// Optimistic user bubble appears in the transcript.
		await expect(page.getByText('Ship it')).toBeVisible()
	})
})

test.describe('Conversation view — IN THIS CHAT panel opens cleanly on mobile', () => {
	// Regression for React error #185 ("Maximum update depth exceeded") when
	// tapping "In this chat" on the mobile viewport — the panel's Sheet mount
	// re-rendered the parent and unstable owner-from-localStorage kicked the
	// participants sync effect into an infinite loop.
	test('opens without triggering a React error at 375px', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const session = buildSession({
			id: 'sess-panel-mobile',
			actorId: 'agent-cos',
			actionPrompt: 'Mobile panel smoke',
			config: { entry_agent_role: 'chief-of-staff' },
		})
		await mockChatsData(page, {
			sessions: [session],
			actors: [
				buildActor({ id: 'agent-cos', name: 'Chief of Staff' }),
				buildActor({ id: 'agent-marketer', name: 'Marketer' }),
			],
		})

		const consoleErrors: string[] = []
		page.on('pageerror', (err) => {
			consoleErrors.push(err.message)
		})
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text())
		})

		await page.goto(`/${account.workspaceId}/chats/${session.id}`)
		await page
			.getByRole('button', { name: /in this chat/i })
			.first()
			.click()
		// The panel's search input renders once the sheet is mounted and the
		// tree is stable — if the render loop crashed, this never appears.
		await expect(page.getByLabel('Search people and agents')).toBeVisible()

		const relevant = consoleErrors.filter(
			(m) => /minified react error #185/i.test(m) || /maximum update depth/i.test(m),
		)
		expect(relevant, `Unexpected React errors: ${relevant.join('\n')}`).toEqual([])
	})
})

test.describe('Conversation view — viewports', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shell is reachable and does not overflow horizontally at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const session = buildSession({
				id: 'sess-vp',
				actorId: 'agent-cos',
				actionPrompt: 'Viewport smoke — conversation shell',
				config: { entry_agent_role: 'chief-of-staff' },
			})
			await mockChatsData(page, {
				sessions: [session],
				actors: [buildActor({ id: 'agent-cos', name: 'Chief of Staff' })],
			})

			await page.goto(`/${account.workspaceId}/chats/${session.id}`)
			await expect(page.getByRole('heading', { level: 1, name: /viewport smoke/i })).toBeVisible()

			if (viewport.width < 768) {
				// Back control shows on mobile so operators aren't stranded on
				// the conversation with no way out.
				await expect(page.getByRole('link', { name: /back to chats/i })).toBeVisible()
			}
			await expectNoHorizontalScroll(page)
		})
	}
})
