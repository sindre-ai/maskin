import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openSidebarOnMobile } from '../helpers/sidebar.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Chats list (T2 of bet `chats-list-conversation`).
//
// DoD:
//  1. List groups conversations by recency — each row: avatar, title, unread
//     marker, time, snippet, status tag.
//  2. Empty list renders the empty state with a single "Start a new one" CTA.
//  3. Full list renders the earlier-group terminal line with the real count.
//  4. Responsive 375–1024px with no horizontal scroll.
//
// Everything the page reads (sessions, actors, notifications) is mocked at the
// API boundary so no real Docker-backed sessions are required.

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

function isoDaysAgo(days: number, hour = 10): string {
	const d = new Date()
	d.setDate(d.getDate() - days)
	d.setHours(hour, 0, 0, 0)
	return d.toISOString()
}

function buildSession(
	overrides: Partial<MockSession> & { id: string; actorId: string; actionPrompt: string },
): MockSession {
	return {
		workspaceId: 'ws',
		triggerId: null,
		status: 'running',
		containerId: null,
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: isoDaysAgo(0),
		completedAt: null,
		timeoutAt: null,
		createdBy: overrides.actorId,
		createdAt: isoDaysAgo(0),
		updatedAt: isoDaysAgo(0),
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
	opts: {
		sessions: MockSession[]
		actors: MockActor[]
		notifications?: Array<{ id: string; sessionId: string; status: string }>
	},
) {
	// Only the list endpoints are mocked — by-id GETs (e.g. a session detail
	// fetch) fall through to the real stack. Matches chat.helper conventions.
	await page.route('**/api/sessions*', async (route) => {
		const url = new URL(route.request().url())
		if (route.request().method() !== 'GET' || !url.pathname.endsWith('/api/sessions'))
			return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(opts.sessions),
		})
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
		const url = new URL(route.request().url())
		if (route.request().method() !== 'GET' || !url.pathname.endsWith('/api/notifications'))
			return route.fallback()
		const now = new Date().toISOString()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				(opts.notifications ?? []).map((n) => ({
					id: n.id,
					workspaceId: 'ws',
					type: 'needs_input',
					title: 'Needs an answer',
					content: null,
					metadata: null,
					sourceActorId: n.sessionId,
					targetActorId: null,
					objectId: null,
					sessionId: n.sessionId,
					status: n.status,
					resolvedAt: null,
					createdAt: now,
					updatedAt: now,
				})),
			),
		})
	})

	// Opening the new-conversation composer bootstraps a persistent chat
	// session (POST /api/sessions) and subscribes to its logs stream. Mock
	// those too so no real Docker-backed session is created by the spec.
	const chatSession = {
		id: 'e2e-chat-session',
		workspaceId: 'ws',
		actorId: opts.actors[0]?.id ?? 'e2e-agent-actor',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'New conversation',
		config: { interactive: true },
		result: null,
		snapshotPath: null,
		startedAt: new Date().toISOString(),
		completedAt: null,
		timeoutAt: null,
		createdBy: opts.actors[0]?.id ?? 'e2e-agent-actor',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		currentActivity: null,
	}
	await page.route('**/api/sessions', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback()
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify(chatSession),
		})
	})
	await page.route('**/api/sessions/e2e-chat-session*', async (route) => {
		const url = new URL(route.request().url())
		if (route.request().method() !== 'GET') return route.fallback()
		if (url.pathname.endsWith('/logs/stream')) {
			await route.fulfill({
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
				body: 'retry: 600000\n\n',
			})
			return
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(chatSession),
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

test.describe('Chats list — empty state', () => {
	test('renders the empty state with a single CTA that opens the composer', async ({
		page,
		account,
	}) => {
		await mockChatsData(page, { sessions: [], actors: [] })
		await page.goto(`/${account.workspaceId}/chats`)
		const list = page.getByTestId('chats-list')
		await expect(list.getByText('No conversations here')).toBeVisible()
		const cta = list.getByRole('button', { name: /start a new one/i })
		await expect(cta).toBeVisible()
		await cta.click()
		await expect(page.getByText('New conversation')).toBeVisible()
	})
})

test.describe('Chats list — populated', () => {
	const sessions: MockSession[] = [
		buildSession({
			id: 's-today',
			actorId: 'a-1',
			actionPrompt: 'Review the launch plan',
			currentActivity: 'Compiling notes',
			status: 'running',
			createdAt: isoDaysAgo(0),
			updatedAt: isoDaysAgo(0),
		}),
		buildSession({
			id: 's-yesterday',
			actorId: 'a-1',
			actionPrompt: 'Draft the release blurb',
			status: 'completed',
			createdAt: isoDaysAgo(1, 16),
			updatedAt: isoDaysAgo(1, 16),
		}),
		buildSession({
			id: 's-week',
			actorId: 'a-2',
			actionPrompt: 'Research migration options',
			status: 'paused',
			createdAt: isoDaysAgo(4),
			updatedAt: isoDaysAgo(4),
		}),
		buildSession({
			id: 's-earlier',
			actorId: 'a-2',
			actionPrompt: 'Archive old notes',
			status: 'failed',
			createdAt: isoDaysAgo(21),
			updatedAt: isoDaysAgo(21),
		}),
	]
	const actors: MockActor[] = [
		buildActor({ id: 'a-1', name: 'Planner' }),
		buildActor({ id: 'a-2', name: 'Reviewer' }),
	]

	test('groups rows by recency with avatar, title, snippet, and status tag', async ({
		page,
		account,
	}) => {
		await mockChatsData(page, { sessions, actors })
		await page.goto(`/${account.workspaceId}/chats`)

		// Scoped to the list container — the sidebar Activity group renders the
		// same running-agent name/activity from the mocked endpoints.
		const list = page.getByTestId('chats-list')

		await expect(list.getByText('Today')).toBeVisible()
		await expect(list.getByText('Review the launch plan')).toBeVisible()
		await expect(list.getByText('Compiling notes')).toBeVisible()
		await expect(list.getByText('Working')).toBeVisible()

		await expect(list.getByText('Yesterday')).toBeVisible()
		await expect(list.getByText('Draft the release blurb')).toBeVisible()
		await expect(list.getByText('Done')).toBeVisible()

		await expect(list.getByText('This week')).toBeVisible()
		await expect(list.getByText('Research migration options')).toBeVisible()

		await expect(list.getByText('Earlier')).toBeVisible()
		await expect(list.getByText('Archive old notes')).toBeVisible()
		await expect(list.getByText('Failed')).toBeVisible()

		// Row leads with the agent avatar resolved from the actors list.
		await expect(list.getByTitle('Planner')).toBeVisible()
		await expect(list.getByTitle('Reviewer')).toBeVisible()
	})

	test('marks a session unread when an open needs_input notification references it', async ({
		page,
		account,
	}) => {
		await mockChatsData(page, {
			sessions,
			actors,
			notifications: [{ id: 'n-1', sessionId: 's-today', status: 'pending' }],
		})
		await page.goto(`/${account.workspaceId}/chats`)
		const list = page.getByTestId('chats-list')
		await expect(list.getByRole('button', { name: /review the launch plan/i })).toBeVisible()
		await expect(list.getByLabel('Unread')).toHaveCount(1)
	})

	test('renders the full-history terminal line with the exact count', async ({ page, account }) => {
		await mockChatsData(page, { sessions, actors })
		await page.goto(`/${account.workspaceId}/chats`)
		await expect(
			page
				.getByTestId('chats-list')
				.getByText(
					`That's the whole history — ${sessions.length} conversations in this workspace.`,
				),
		).toBeVisible()
	})

	test('row selection opens the chat panel with the agent staged', async ({ page, account }) => {
		await mockChatsData(page, { sessions, actors })
		await page.goto(`/${account.workspaceId}/chats`)
		await page.getByRole('button', { name: /research migration options/i }).click()
		// The right-hand chat panel attaches the staged agent as a chip.
		await expect(page.getByText('Reviewer')).toBeVisible()
	})
})

test.describe('Chats list — viewports', () => {
	const sessions: MockSession[] = [1, 2, 3, 4, 5].map((i) =>
		buildSession({
			id: `s-${i}`,
			actorId: 'a-1',
			actionPrompt: `Long-running conversation ${i} about workspace automation`,
			status: 'running',
			createdAt: isoDaysAgo(21 + i),
			updatedAt: isoDaysAgo(21 + i),
		}),
	)
	const actors: MockActor[] = [buildActor({ id: 'a-1', name: 'Planner' })]

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`list stays visible and has no horizontal scroll at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockChatsData(page, {
				sessions: [
					...sessions,
					buildSession({
						id: 's-today',
						actorId: 'a-1',
						actionPrompt: 'Today: triage the inbox',
						status: 'running',
						createdAt: isoDaysAgo(0),
						updatedAt: isoDaysAgo(0),
					}),
				],
				actors,
			})
			if (viewport.width < 768) {
				await openSidebarOnMobile(page)
				await page.getByRole('link', { name: 'Chats' }).click()
			} else {
				await page.goto(`/${account.workspaceId}/chats`)
			}
			await expect(page.getByRole('button', { name: /today: triage the inbox/i })).toBeVisible()
			await expect(page.getByText(/that's the whole history/i)).toBeVisible()
			await expectNoHorizontalScroll(page)
		})
	}
})
