import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// SidebarFooter Activity group (T2 of bet `sidebar-legibility`).
//
// AC-U4: 1–5 running agents render as named rows with current activity.
// AC-U5: >5 running agents render 5 rows + a `+N more` toggle that expands inline.
// AC-U6: 0 running agents render a muted "No agents running" line.
// AC-U7: SSE-driven cache invalidation reflects start/stop without a page refresh.
// AC-T2 (activity side): loading skeleton, and hiding on error, must not shift the sidebar shell.
// AC-T3 (activity side): icon-collapsed mode hides the entire Activity group.
//
// Sessions + actors are mocked at the API boundary so the spec does not need real
// running containers.

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

function buildSession(
	overrides: Partial<MockSession> & { id: string; actorId: string },
): MockSession {
	return {
		workspaceId: 'ws',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Do something',
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: '2026-01-01T00:00:00Z',
		completedAt: null,
		timeoutAt: null,
		createdBy: overrides.actorId,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: null,
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

async function mockSessionsAndActors(page: Page, sessions: MockSession[], actors: MockActor[]) {
	await page.route('**/api/sessions*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(sessions),
		})
	})
	await page.route('**/api/actors*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(actors),
		})
	})
}

test.describe('Sidebar Activity group', () => {
	test('renders 1–5 named agent rows with current activity (AC-U4)', async ({ page, account }) => {
		await mockSessionsAndActors(
			page,
			[
				buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' }),
				buildSession({ id: 's-2', actorId: 'a-2', currentActivity: 'Reviewing diff' }),
			],
			[buildActor({ id: 'a-1', name: 'Planner' }), buildActor({ id: 'a-2', name: 'Reviewer' })],
		)
		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('Activity')).toBeVisible()
		await expect(group.getByText('Planner')).toBeVisible()
		await expect(group.getByText('Reading files')).toBeVisible()
		await expect(group.getByText('Reviewer')).toBeVisible()
		await expect(group.getByText('Reviewing diff')).toBeVisible()
	})

	test('collapses >5 agents into 5 rows + a "+N more" toggle that expands inline (AC-U5)', async ({
		page,
		account,
	}) => {
		const sessions = Array.from({ length: 7 }, (_, i) =>
			buildSession({ id: `s-${i}`, actorId: `a-${i}`, currentActivity: `Task ${i}` }),
		)
		const actors = Array.from({ length: 7 }, (_, i) =>
			buildActor({ id: `a-${i}`, name: `Agent ${i}` }),
		)
		await mockSessionsAndActors(page, sessions, actors)
		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('Agent 0')).toBeVisible()
		await expect(group.getByText('Agent 4')).toBeVisible()
		await expect(group.getByText('Agent 5')).toHaveCount(0)
		const more = group.getByRole('button', { name: '+2 more' })
		await expect(more).toBeVisible()
		await more.click()
		await expect(group.getByText('Agent 5')).toBeVisible()
		await expect(group.getByText('Agent 6')).toBeVisible()
		await group.getByRole('button', { name: 'Show fewer' }).click()
		await expect(group.getByText('Agent 5')).toHaveCount(0)
	})

	test('renders "No agents running" when nothing is active (AC-U6)', async ({ page, account }) => {
		await mockSessionsAndActors(page, [], [])
		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('No agents running')).toBeVisible()
	})

	test('hides the Activity group when the sessions request errors (AC-T2)', async ({
		page,
		account,
	}) => {
		await page.route('**/api/sessions*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({ status: 500, body: 'boom' })
		})
		await page.route('**/api/actors*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([]),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		// The sidebar shell (nav + For You link) still renders.
		await expect(page.getByRole('link', { name: 'For You' })).toBeVisible()
		// The Activity group disappears entirely — no error state, no shift.
		await expect(page.getByTestId('sidebar-activity')).toHaveCount(0)
	})

	test('reflects an agent start via SSE without a page refresh (AC-U7)', async ({
		page,
		account,
	}) => {
		const startedSession = buildSession({
			id: 's-sse-1',
			actorId: 'a-sse-1',
			currentActivity: 'Starting up',
		})
		let sessionCalls = 0
		await page.route('**/api/sessions*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			sessionCalls += 1
			const sessions = sessionCalls === 1 ? [] : [startedSession]
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(sessions),
			})
		})
		await page.route('**/api/actors*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([buildActor({ id: 'a-sse-1', name: 'Planner' })]),
			})
		})

		const sseEvent = {
			id: 'evt-sse-1',
			action: 'session_started',
			workspace_id: account.workspaceId,
			actor_id: 'a-sse-1',
			entity_type: 'session',
			entity_id: 's-sse-1',
			event_id: 'evt-sse-1',
		}
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
				body: `retry: 600000\n\nevent: session_started\ndata: ${JSON.stringify(sseEvent)}\n\n`,
			})
		})

		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('No agents running')).toBeVisible()

		// The `session` entity SSE event broad-invalidates the sessions query;
		// the running agent appears without a page.reload().
		await expect(group.getByText('Planner')).toBeVisible()
		await expect(group.getByText('Starting up')).toBeVisible()
		expect(sessionCalls).toBeGreaterThanOrEqual(2)
	})

	test('reflects an agent stop via SSE without a page refresh (AC-U7)', async ({
		page,
		account,
	}) => {
		const runningSession = buildSession({
			id: 's-sse-2',
			actorId: 'a-sse-2',
			currentActivity: 'Wrapping up',
		})
		let sessionCalls = 0
		await page.route('**/api/sessions*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			sessionCalls += 1
			const sessions = sessionCalls === 1 ? [runningSession] : []
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(sessions),
			})
		})
		await page.route('**/api/actors*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([buildActor({ id: 'a-sse-2', name: 'Reviewer' })]),
			})
		})

		const sseEvent = {
			id: 'evt-sse-2',
			action: 'session_completed',
			workspace_id: account.workspaceId,
			actor_id: 'a-sse-2',
			entity_type: 'session',
			entity_id: 's-sse-2',
			event_id: 'evt-sse-2',
		}
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'GET') return route.continue()
			await route.fulfill({
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
				body: `retry: 600000\n\nevent: session_completed\ndata: ${JSON.stringify(sseEvent)}\n\n`,
			})
		})

		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('Reviewer')).toBeVisible()

		// The `session` entity SSE event broad-invalidates the sessions query;
		// the completed agent drops out without a page.reload().
		await expect(group.getByText('No agents running')).toBeVisible()
		expect(sessionCalls).toBeGreaterThanOrEqual(2)
	})

	test('hides the Activity group in icon-collapsed mode and shows it when expanded (AC-T3)', async ({
		page,
		account,
	}) => {
		await mockSessionsAndActors(
			page,
			[buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' })],
			[buildActor({ id: 'a-1', name: 'Planner' })],
		)
		await page.goto(`/${account.workspaceId}`)
		const group = page.getByTestId('sidebar-activity')
		await expect(group.getByText('Planner')).toBeVisible()

		// Toggle sidebar to icon-collapsed mode via the rail.
		const rail = page.getByRole('button', { name: 'Toggle Sidebar' })
		await rail.click()
		await expect(group.getByText('Planner')).toHaveCount(0)

		// Toggle back to expanded — the Activity group re-appears.
		await rail.click()
		await expect(group.getByText('Planner')).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Activity rows are visible at ${viewport.label} (AC-U4)`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockSessionsAndActors(
				page,
				[buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' })],
				[buildActor({ id: 'a-1', name: 'Planner' })],
			)
			await page.goto(`/${account.workspaceId}`)
			// On mobile the sidebar is a drawer — open it via the mobile trigger in the header.
			if (viewport.width < 768) {
				const trigger = page.getByRole('button', { name: /toggle sidebar/i })
				if (await trigger.count()) await trigger.first().click()
			}
			await expect(page.getByTestId('sidebar-activity').getByText('Planner')).toBeVisible()
		})
	}
})
