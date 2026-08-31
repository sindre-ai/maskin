import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openSidebarOnMobile } from '../helpers/sidebar.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// SidebarFooter Activity card (v2 app shell).
//
// v2 replaced the named-row Activity list with one compact card
// (`components/layout/sidebar-activity.tsx`): a live dot, a stack of the agents
// holding a live session, the working/idle word, and a sessions count. It is
// also the only way the v2 shell reaches /agents, since Agents left the nav.
//
// AC-U4: agents with live sessions render as an avatar stack + "working".
// AC-U5: agents beyond the avatar limit collapse into a `+N` tile.
// AC-U6: 0 running agents render "idle" / "nothing running".
// AC-U7: SSE-driven cache invalidation reflects start/stop without a refresh.
// AC-T2: hiding on error must not shift the sidebar shell.
// AC-T3: icon-collapsed mode replaces the card with the bare live dot.
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

test.describe('Sidebar Activity card', () => {
	test('renders one avatar per working agent with a sessions count (AC-U4)', async ({
		page,
		account,
	}) => {
		await mockSessionsAndActors(
			page,
			[
				buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' }),
				buildSession({ id: 's-2', actorId: 'a-2', currentActivity: 'Reviewing diff' }),
			],
			[buildActor({ id: 'a-1', name: 'Planner' }), buildActor({ id: 'a-2', name: 'Reviewer' })],
		)
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('sidebar-activity')
		await expect(card.getByText('working', { exact: true })).toBeVisible()
		await expect(card.getByText('2 sessions running')).toBeVisible()
		// One avatar per distinct agent, not per session (ActorAvatar sets title={name}).
		await expect(card.getByTitle('Planner')).toBeVisible()
		await expect(card.getByTitle('Reviewer')).toBeVisible()
	})

	test('collapses agents beyond the avatar limit into a +N tile (AC-U5)', async ({
		page,
		account,
	}) => {
		// Two agents, three live sessions — the sessions list carries one row per
		// session, so the left half must collapse by actor while the right does not.
		await mockSessionsAndActors(
			page,
			[
				buildSession({ id: 's-1', actorId: 'a-1' }),
				buildSession({ id: 's-2', actorId: 'a-1' }),
				buildSession({ id: 's-3', actorId: 'a-2' }),
			],
			[buildActor({ id: 'a-1', name: 'Planner' }), buildActor({ id: 'a-2', name: 'Reviewer' })],
		)
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('sidebar-activity')
		// AVATAR_LIMIT is 4, so the 3 remaining agents collapse into one tile.
		await expect(card.getByTitle('Agent 0')).toBeVisible()
		await expect(card.getByTitle('Agent 3')).toBeVisible()
		await expect(card.getByTitle('Agent 4')).toHaveCount(0)
		await expect(card.getByText('+3', { exact: true })).toBeVisible()
		await expect(card.getByText('7 sessions running')).toBeVisible()
	})

	test('renders idle / "nothing running" when nothing is active (AC-U6)', async ({
		page,
		account,
	}) => {
		await mockSessionsAndActors(page, [], [])
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('sidebar-activity')
		await expect(card.getByText('idle', { exact: true })).toBeVisible()
		await expect(card.getByText('nothing running')).toBeVisible()
	})

	test('is the v2 shell entry point to Agents', async ({ page, account }) => {
		await mockSessionsAndActors(page, [], [])
		await page.goto(`/${account.workspaceId}`)
		await page.getByTestId('sidebar-activity').click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents`), { timeout: 10_000 })
	})

	test('hides the Activity card when the sessions request errors (AC-T2)', async ({
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
		// The sidebar shell (nav + For you link) still renders. Scoped to the
		// sidebar container — the mobile nav renders the same entry, which would
		// otherwise collide in strict mode.
		await expect(
			page
				.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]')
				.getByRole('link', { name: 'For you' })
				.first(),
		).toBeVisible()
		// The Activity card disappears entirely — no error state, no shift.
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
		let releaseSseEvent!: () => void
		const sseEventGate = new Promise<void>((resolve) => {
			releaseSseEvent = resolve
		})
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
			// Wait for the test to confirm the initial render before delivering the SSE
			// message — otherwise the mocked event (fulfilled instantly on connect) can
			// race ahead of the sessions query's own in-flight initial fetch. Invalidating
			// a query mid-fetch just dedupes onto the in-flight (stale) request instead of
			// starting a fresh one, so the UI would never pick up the SSE-driven change.
			await sseEventGate
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
		const card = page.getByTestId('sidebar-activity')
		await expect(card.getByText('nothing running')).toBeVisible()
		releaseSseEvent()

		// The `session` entity SSE event broad-invalidates the sessions query;
		// the running agent appears without a page.reload().
		await expect(card.getByText('working', { exact: true })).toBeVisible()
		await expect(card.getByText('1 session running')).toBeVisible()
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
		let releaseSseEvent!: () => void
		const sseEventGate = new Promise<void>((resolve) => {
			releaseSseEvent = resolve
		})
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
			// See the note in the start test — the gate keeps the mocked SSE message
			// from racing the sessions query's own initial fetch.
			await sseEventGate
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
		const card = page.getByTestId('sidebar-activity')
		await expect(card.getByText('working', { exact: true })).toBeVisible()
		releaseSseEvent()

		// The `session` entity SSE event broad-invalidates the sessions query;
		// the completed agent drops out without a page.reload().
		await expect(card.getByText('nothing running')).toBeVisible()
		expect(sessionCalls).toBeGreaterThanOrEqual(2)
	})

	test('collapses to the bare live dot in icon-collapsed mode (AC-T3)', async ({
		page,
		account,
	}) => {
		await mockSessionsAndActors(
			page,
			[buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' })],
			[buildActor({ id: 'a-1', name: 'Planner' })],
		)
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('sidebar-activity')
		await expect(card).toBeVisible()

		// Icon-collapse hides the card via `group-data-[collapsible=icon]:hidden`
		// (CSS display:none) and reveals the dot-only link in its place — neither
		// unmounts, so assert on visibility, not DOM presence. Two controls carry
		// this accessible name (sidebar header + rail); either one toggles.
		const trigger = page.getByRole('button', { name: 'Toggle Sidebar' }).first()
		await trigger.click()
		await expect(card).not.toBeVisible()

		await trigger.click()
		await expect(card).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the Activity card is visible at ${viewport.label} (AC-U4)`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockSessionsAndActors(
				page,
				[buildSession({ id: 's-1', actorId: 'a-1', currentActivity: 'Reading files' })],
				[buildActor({ id: 'a-1', name: 'Planner' })],
			)
			await page.goto(`/${account.workspaceId}`)
			// On mobile the sidebar is a drawer — open it via the mobile trigger in the header.
			if (viewport.width < 768) {
				await openSidebarOnMobile(page)
			}
			await expect(page.getByTestId('sidebar-activity')).toBeVisible()
		})
	}
})
