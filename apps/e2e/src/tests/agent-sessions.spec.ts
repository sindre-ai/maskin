import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

interface MockSession {
	id: string
	status: string
	actionPrompt: string
	snapshotPath?: string | null
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

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const section = page.getByRole('region', { name: 'Sessions' })
			await expect(section).toBeVisible({ timeout: 10_000 })

			// The section note says what you can do here (mockup 2427), not a count.
			await expect(section.getByText('open, pause or restart')).toBeVisible()

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

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			const section = page.getByRole('region', { name: 'Sessions' })
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

			// Below `md` the row controls live inside the expanded panel, so the
			// running session has to be opened to reach them on a phone.
			if (vp.width < 768) {
				await section.getByRole('button', { name: 'View details for Hold the queue' }).click()
			}

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

			// The paused session offers Resume instead (it has a snapshot to
			// restore from); on a phone it sits in that row's expanded panel.
			if (vp.width < 768) {
				await section.getByRole('button', { name: 'View details for Ready to resume' }).click()
			}
			await expect(resume).toBeVisible()
			const resumed = page.waitForRequest(
				(r) => r.url().includes('/sessions/sess-hold/resume') && r.method() === 'POST',
			)
			await resume.click()
			await resumed
		})
	}
})
