import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openAgentTab } from '../helpers/agent-tab.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

interface MockSession {
	id: string
	status: string
	actionPrompt: string
	createdAt: string
	startedAt?: string | null
}

/**
 * Serves a fixed session list for the agent page. Real runs need a container runtime, which
 * the web stack does not have in CI. The glob stops at the first `/`, so
 * `POST /sessions/:id/...` still reaches the API.
 */
async function mockSessions(page: Page, actorId: string, sessions: MockSession[]) {
	await page.route('**/api/sessions*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				sessions.map((s) => ({
					id: s.id,
					workspaceId: 'ws',
					actorId,
					triggerId: null,
					status: s.status,
					containerId: 'c-1',
					actionPrompt: s.actionPrompt,
					config: null,
					result: null,
					snapshotPath: null,
					startedAt: s.startedAt ?? s.createdAt,
					completedAt: s.status === 'running' ? null : s.createdAt,
					timeoutAt: null,
					createdBy: actorId,
					createdAt: s.createdAt,
					updatedAt: s.createdAt,
					currentActivity: null,
				})),
			),
		})
	})
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('Agent detail v11 — tabs, crumb bar, banners', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`tabs are reachable by touch and deep link @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Tab Tess')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			for (const tab of ['setup', 'triggers', 'items', 'sessions', 'computer'] as const) {
				await openAgentTab(page, tab)
			}
			await expect(page).toHaveURL(/tab=computer/)

			// The retired Overview link lands on Setup, the first tab.
			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=overview`)
			await expect(page.getByRole('tab', { name: /^Setup/ })).toHaveAttribute(
				'aria-selected',
				'true',
				{ timeout: 10_000 },
			)
			await expect(page.getByRole('tab', { name: /^Overview/ })).toHaveCount(0)
			await expectNoHorizontalOverflow(page)

			// The tab is in the URL, so a reload and a shared link land on it.
			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=sessions`)
			await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
				'aria-selected',
				'true',
				{ timeout: 10_000 },
			)
			await expect(page.getByRole('region', { name: 'Sessions', exact: true })).toBeVisible()
		})

		test(`trigger switch persists and empty state offers New trigger @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const empty = await account.api.createAgentActor('Idle Ida')
			await account.api.addWorkspaceMember(account.workspaceId, empty.id)
			await page.goto(`/${account.workspaceId}/agents/${empty.id}?tab=triggers`)

			// A new agent already has its Heartbeat trigger, so the empty copy is
			// covered by the unit test; here the picker is what matters.
			await expect(page.getByRole('switch', { name: /heartbeat/i })).toBeVisible({
				timeout: 10_000,
			})
			await page.getByRole('button', { name: /new trigger/i }).click()
			await expect(page.getByRole('dialog')).toBeVisible()
			await page.keyboard.press('Escape')

			const agent = await account.api.createAgentActor('Wake Wanda')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Triage events',
				type: 'event',
				action_prompt: 'Summarise the new event',
				target_actor_id: agent.id,
				config: { entity_type: 'insight', action: 'created' },
			})
			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=triggers`)
			const toggle = page.getByRole('switch', { name: /turn off triage events/i })
			await expect(toggle).toBeVisible({ timeout: 10_000 })
			await toggle.click()
			await expect(page.getByRole('switch', { name: /turn on triage events/i })).not.toBeChecked()

			await page.reload()
			await expect(page.getByRole('switch', { name: /turn on triage events/i })).not.toBeChecked()
		})

		test(`Message opens the agent chat; Disable shows the banner @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Pause Pia')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			// The crumb bar carries Message, Live and the enable/disable switch.
			const bar = page.locator('header')
			await expect(bar.getByRole('button', { name: 'Message', exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(bar.getByRole('button', { name: 'Call Pause Pia' })).toBeVisible()

			const banner = page.getByText(
				'Disabled. Running sessions were held where they stopped. Enable the agent to continue.',
			)
			await expect(banner).toHaveCount(0)
			await page.getByRole('button', { name: 'Disable agent' }).click()
			await expect(banner).toBeVisible()

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(banner).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			await bar.getByRole('button', { name: 'Message', exact: true }).click()
			await expect(page).toHaveURL(/\/chats\/new\?.*agentId=/, { timeout: 10_000 })
		})

		test(`Working-now card shows a live run @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Live Lena')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await mockSessions(page, agent.id, [
				{
					id: 'sess-live',
					status: 'running',
					actionPrompt: 'Fix duplicate bookings',
					createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
				},
				{
					id: 'sess-done',
					status: 'completed',
					actionPrompt: 'Open the pull request',
					createdAt: '2026-01-01T00:00:00Z',
				},
			])
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const card = page.getByTestId('agent-working-now')
			await expect(card).toBeVisible({ timeout: 10_000 })
			await expect(card.getByText('Fix duplicate bookings')).toBeVisible()
			await expect(card.getByText(/Running for/)).toBeVisible()
			await expect(card.getByRole('button', { name: 'Watch' })).toBeVisible()
			await expect(card.getByRole('button', { name: 'Message' })).toBeVisible()
			await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible()
			await expectNoHorizontalOverflow(page)

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(card).toBeVisible()
				await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// The Sessions tab lists the runs with a status word each.
			await openAgentTab(page, 'sessions')
			await expect(
				page.getByRole('button', { name: /^Open Fix duplicate bookings/ }).getByText('Working'),
			).toBeVisible()
			await expect(
				page.getByRole('button', { name: /^Open Open the pull request/ }).getByText('Done'),
			).toBeVisible()
		})

		test(`failed banner offers Retry and See log @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Fail Finn')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await mockSessions(page, agent.id, [
				{
					id: 'sess-ok',
					status: 'completed',
					actionPrompt: 'Review PR 2024',
					createdAt: '2026-01-01T00:00:00Z',
				},
				{
					id: 'sess-bad',
					status: 'failed',
					actionPrompt: 'Review PR 2031',
					createdAt: '2026-01-02T00:00:00Z',
				},
			])
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const banner = page.getByTestId('agent-failed-banner')
			await expect(banner).toBeVisible({ timeout: 10_000 })
			await expect(banner.getByText('Fail Finn stopped on its last run')).toBeVisible()
			await expect(banner.getByRole('button', { name: 'See log' })).toBeVisible()
			await expectNoHorizontalOverflow(page)

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(banner).toBeVisible()
				await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Retry starts a new run of the same prompt.
			const created = page.waitForRequest(
				(req) => req.method() === 'POST' && /\/api\/sessions$/.test(req.url()),
			)
			await banner.getByRole('button', { name: 'Retry' }).click()
			const body = (await created).postDataJSON() as { actor_id: string; action_prompt: string }
			expect(body.actor_id).toBe(agent.id)
			expect(body.action_prompt).toBe('Review PR 2031')
		})
	}
})
