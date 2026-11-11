import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { grantEnterprise } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

interface MockSession {
	id: string
	status: string
	actionPrompt: string
	snapshotPath?: string | null
	agentServerId?: string | null
}

/**
 * Serves a fixed session list for the agent-detail route. Real sessions need a
 * container runtime, which CI does not give the web stack — the glob stops at
 * the first `/`, so `POST /sessions/:id/pause` still reaches the API.
 */
async function mockSessions(page: Page, actorId: string, sessions: MockSession[]) {
	await page.route('**/api/sessions*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				sessions.map((s, i) => ({
					id: s.id,
					workspaceId: 'ws',
					actorId,
					triggerId: null,
					status: s.status,
					containerId: 'c-1',
					agentServerId: s.agentServerId ?? null,
					actionPrompt: s.actionPrompt,
					config: null,
					result: null,
					snapshotPath: s.snapshotPath ?? null,
					startedAt: `2026-01-0${i + 1}T00:00:00Z`,
					completedAt: null,
					timeoutAt: null,
					createdBy: actorId,
					createdAt: `2026-01-0${i + 1}T00:00:00Z`,
					updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
					currentActivity: null,
				})),
			),
		})
	})
}

test.describe('Agent detail — Sessions section', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders the Sessions region on the detail route @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Sam Sessions')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// The Sessions tab, by deep link.
			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=sessions`)

			const section = page.getByRole('region', { name: 'Sessions', exact: true })
			await expect(section).toBeVisible({ timeout: 10_000 })

			// The note stays for screen readers; v16 opens the tab on the chips, not on a heading.
			await expect(section.getByText('open, pause or restart')).toBeAttached()

			// Empty state shows when the agent hasn't run anything yet — proves the
			// section renders even without data on the deployed slot.
			await expect(section.getByText('No sessions yet. Runs will show up here.')).toBeVisible()

			// Both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(section).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		// Mockup 2443 (`s.b1`) and 2427 (the bounded list behind "show all").
		test(`pauses a running session and caps the list at five @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Pia Pauser')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await mockSessions(page, agent.id, [
				{ id: 'sess-live', status: 'running', actionPrompt: 'Hold the queue' },
				{
					id: 'sess-hold',
					status: 'paused',
					actionPrompt: 'Ready to resume',
					snapshotPath: 's.tar',
				},
				{ id: 'sess-3', status: 'completed', actionPrompt: 'Run three' },
				{ id: 'sess-4', status: 'completed', actionPrompt: 'Run four' },
				{ id: 'sess-5', status: 'completed', actionPrompt: 'Run five' },
				{ id: 'sess-6', status: 'completed', actionPrompt: 'Run six' },
				{ id: 'sess-7', status: 'completed', actionPrompt: 'Run seven' },
			])

			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=sessions`)
			const section = page.getByRole('region', { name: 'Sessions', exact: true })
			await expect(section).toBeVisible({ timeout: 10_000 })

			// Active runs sort first, then newest-first — so the oldest two sit
			// below the five-row cap until the list is expanded.
			await expect(section.getByText('Run three')).toBeHidden()
			await section.getByRole('button', { name: 'Show all 7' }).click()
			await expect(section.getByText('Run three')).toBeVisible()
			await section.getByRole('button', { name: 'Show fewer' }).click()
			await expect(section.getByText('Run three')).toBeHidden()
			// Re-expand: the paused session is one of the two below the cap.
			await section.getByRole('button', { name: 'Show all 7' }).click()

			const pause = section.getByRole('button', { name: 'Pause', exact: true }).first()
			const resume = section.getByRole('button', { name: 'Resume', exact: true }).first()

			// Both controls are reachable on touch — no hover-only reveal.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(pause).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Pause hits the real write path.
			const paused = page.waitForRequest(
				(r) => r.url().includes('/sessions/sess-live/pause') && r.method() === 'POST',
			)
			await pause.click()
			await paused

			// The paused session offers Resume instead (it has a snapshot to restore from).
			await expect(resume).toBeVisible()
			const resumed = page.waitForRequest(
				(r) => r.url().includes('/sessions/sess-hold/resume') && r.method() === 'POST',
			)
			await resume.click()
			await resumed
		})

		// A session whose sandbox lives on an agent server pauses and resumes too.
		test(`offers Pause and Resume on agent-server sessions @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Rae Remote')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await mockSessions(page, agent.id, [
				{
					id: 'sess-remote-live',
					status: 'running',
					actionPrompt: 'Run on the box',
					agentServerId: 'agent-server-1',
				},
				{
					id: 'sess-remote-hold',
					status: 'paused',
					actionPrompt: 'Parked on the box',
					snapshotPath: 'session-workspaces/sess-remote-hold.tar.gz',
					agentServerId: 'agent-server-1',
				},
			])

			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=sessions`)
			const section = page.getByRole('region', { name: 'Sessions', exact: true })
			await expect(section).toBeVisible({ timeout: 10_000 })

			const pause = section.getByRole('button', { name: 'Pause', exact: true }).first()
			const resume = section.getByRole('button', { name: 'Resume', exact: true }).first()

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(pause).toBeVisible()
				await expect(resume).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			const paused = page.waitForRequest(
				(r) => r.url().includes('/sessions/sess-remote-live/pause') && r.method() === 'POST',
			)
			await pause.click()
			await paused

			const resumed = page.waitForRequest(
				(r) => r.url().includes('/sessions/sess-remote-hold/resume') && r.method() === 'POST',
			)
			await resume.click()
			await resumed
		})
	}
})

// Session detail failure card (v10 "Session failure recovery"). The card lives
// in SessionDetailPanel, which the object's Origin block opens. A real failed
// run needs a container runtime, so the session row is served from a route
// mock; the object, the agent and the `produced_by` edge are real.
interface RecoveryCase {
	code: string
	// Without the Keys page (the default workspace): Maskin's own credential failed.
	ours: string
	// With the Keys page: the one button and where it lands.
	keysTitle: string
	button: string
	hash: string
	topUp?: boolean
}

const PAUSED = 'Agents are paused on our side'

const RECOVERY_CASES: RecoveryCase[] = [
	{
		code: 'oauth_expired',
		ours: PAUSED,
		keysTitle: 'Claude login expired',
		button: 'Reconnect Claude',
		hash: 'claude-subscriptions',
	},
	{
		code: 'oauth_revoked',
		ours: PAUSED,
		keysTitle: 'Claude login expired',
		button: 'Reconnect Claude',
		hash: 'claude-subscriptions',
	},
	{
		code: 'not_logged_in',
		ours: PAUSED,
		keysTitle: 'Claude is not connected',
		button: 'Connect Claude',
		hash: 'claude-subscriptions',
	},
	{
		code: 'invalid_api_key',
		ours: PAUSED,
		keysTitle: 'The API key was rejected',
		button: 'Replace API key',
		hash: 'llm-api-keys',
	},
	{
		code: 'session_limit',
		ours: PAUSED,
		keysTitle: 'Usage limit reached',
		button: 'Add a backup subscription',
		hash: 'claude-subscriptions',
	},
	{
		code: 'weekly_limit',
		ours: PAUSED,
		keysTitle: 'Usage limit reached',
		button: 'Add a backup subscription',
		hash: 'claude-subscriptions',
	},
	{
		code: 'credit_balance_low',
		ours: PAUSED,
		keysTitle: 'Anthropic credit is low',
		button: 'Change API key',
		hash: 'llm-api-keys',
		topUp: true,
	},
]

async function openFailedSession(
	page: Page,
	account: {
		api: import('../helpers/api.helper').TestAPI
		workspaceId: string
	},
	reasonCode: string,
	provider: string,
) {
	const agent = await account.api.createAgentActor('Fay Failing')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const object = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: `Failed run ${reasonCode}`,
		status: 'todo',
	})
	const session = await account.api.createSession(account.workspaceId, {
		actor_id: agent.id,
		action_prompt: 'Draft the weekly note',
		auto_start: false,
	})
	await account.api.createRelationship(account.workspaceId, {
		source_type: 'session',
		source_id: session.id,
		target_type: 'task',
		target_id: object.id,
		type: 'produced_by',
	})

	const failed = {
		...session,
		status: 'failed',
		startedAt: '2026-01-01T00:00:00Z',
		completedAt: '2026-01-01T00:01:00Z',
		result: {
			exit_code: 1,
			failure_reason: {
				provider,
				reason_code: reasonCode,
				human_message: 'Stored message from the server',
				http_status: null,
				reset_at: null,
				verbatim_output: null,
			},
		},
	}
	await page.route(new RegExp(`/api/sessions/${session.id}(\\?.*)?$`), async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(failed),
		})
	})

	// POST /api/relationships derives every endpoint kind as 'object' or 'file';
	// only the server's own provenance writer stamps a session source. So the
	// graph answer is patched to carry the kind that writer would have stored.
	await page.route(new RegExp(`/api/objects/${object.id}/graph(\\?.*)?$`), async (route) => {
		const response = await route.fetch()
		const graph = await response.json()
		for (const rel of graph.relationships ?? []) {
			if (rel.type === 'produced_by' && rel.sourceId === session.id) {
				rel.sourceType = 'session'
				rel.sourceTitle = 'Draft the weekly note'
			}
		}
		await route.fulfill({ response, json: graph })
	})
	await page.goto(`/${account.workspaceId}/objects/${object.id}`, {
		waitUntil: 'domcontentloaded',
	})
	await page.getByRole('button', { name: 'Origin — click to expand' }).click({ timeout: 15_000 })
	await page.getByRole('button', { name: 'Draft the weekly note' }).click()
	const panel = page.getByRole('dialog')
	await expect(panel).toBeVisible()
	return panel
}

test.describe('Session detail — failure recovery', () => {
	// The all-codes test opens seven pages in a row.
	test.describe.configure({ timeout: 120_000 })

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a workspace without the Keys page reads "paused on our side" with no button for every code @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			for (const c of RECOVERY_CASES) {
				const panel = await openFailedSession(page, account, c.code, 'anthropic')
				await expect(panel.getByText(c.ours, { exact: true })).toBeVisible()
				await expect(panel.getByText(c.code, { exact: true })).toBeVisible()
				await expect(panel.getByText('Stored message from the server')).toHaveCount(0)
				await expect(panel.getByText('Nothing for you to do. We are working on it.')).toBeVisible()
				await expect(panel.getByRole('link', { name: c.button })).toHaveCount(0)
				await page.keyboard.press('Escape')
			}

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		test(`a plan-cap stop offers Go to Billing @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const panel = await openFailedSession(page, account, 'plan_cap_exceeded', 'maskin')
			await expect(panel.getByText('Plan cap reached', { exact: true })).toBeVisible()
			await expect(
				panel.getByText('This workspace used its included sessions for the month.'),
			).toBeVisible()
			const billing = panel.getByRole('link', { name: 'Go to Billing' })
			await expect(billing).toBeVisible()
			await expect(billing).toHaveAttribute('href', `/${account.workspaceId}/settings/billing`)
		})
	}

	// Needs MASKIN_TEST_GRANT_TOKEN on both the run and the API stack, like the
	// other specs that drive the Keys page (see helpers/plan.helper.ts). CI sets
	// it; a local stack usually does not, so these cases skip with a reason there
	// instead of failing inside grantEnterprise.
	for (const c of RECOVERY_CASES) {
		test(`${c.code} with the Keys page shows "${c.button}" linking to #${c.hash}`, async ({
			page,
			account,
		}) => {
			test.skip(
				!process.env.MASKIN_TEST_GRANT_TOKEN && !process.env.CI,
				'needs MASKIN_TEST_GRANT_TOKEN on the run and the API stack (not set locally)',
			)
			await grantEnterprise(account.apiKey, account.workspaceId)

			const panel = await openFailedSession(page, account, c.code, 'anthropic')
			await expect(panel.getByText(c.keysTitle, { exact: true })).toBeVisible()
			await expect(panel.getByRole('link', { name: c.button })).toHaveAttribute(
				'href',
				`/${account.workspaceId}/settings/keys#${c.hash}`,
			)
			const topUp = panel.getByRole('link', { name: /Top up on Anthropic/ })
			if (c.topUp) await expect(topUp).toBeVisible()
			else await expect(topUp).toHaveCount(0)
		})
	}
})
