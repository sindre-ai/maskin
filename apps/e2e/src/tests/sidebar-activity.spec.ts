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
// AC-T3 (activity side): icon-collapsed mode collapses to a vertical stack of status dots.
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
