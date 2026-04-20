import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { buildNotificationFixture, installSindreMocks } from '../helpers/sindre.helper'

/**
 * E2E coverage for the Sindre chat surfaces (task 45):
 *   1. Pulse input bar forwards the message to the overlay sheet and the
 *      transcript shows a streamed reply.
 *   2. Slash picker multi-selects two objects, single-selects one agent,
 *      and a second agent pick replaces the first (single-agent rule).
 *   3. Refresh preserves the conversation — the persisted session id in
 *      localStorage is reused and the stream resubscribes, no new session
 *      is created.
 *   4. A PulseCard's "Talk to Sindre" action opens the sheet with the
 *      originating notification seeded as a selection chip.
 *
 * All tests mock the Sindre session + SSE surface so the specs do not
 * require a live Docker-backed interactive session; the real backend is
 * still used for auth, workspaces, and anything else not explicitly
 * intercepted.
 */

async function openSheetFromSidebar(page: Page) {
	await page.getByRole('button', { name: 'Sindre', exact: true }).click()
	await expect(page.getByRole('heading', { name: 'Sindre' })).toBeVisible()
}

test.describe('Sindre chat surfaces', () => {
	test('pulse input bar forwards to the sheet and streams the reply', async ({ page, account }) => {
		const mocks = await installSindreMocks(page, {
			workspaceId: account.workspaceId,
			humanActorId: account.actorId,
			humanActorName: 'E2E Test User',
			streamEvents: [
				{
					type: 'assistant',
					message: {
						id: 'msg-e2e-1',
						content: [{ type: 'text', text: 'Hi from Sindre E2E' }],
					},
				},
			],
		})

		await page.goto(`/${account.workspaceId}`)

		const pulseBar = page.locator('[data-surface="pulse-bar"]')
		const pulseInput = pulseBar.getByPlaceholder('Ask Sindre anything…')
		await expect(pulseInput).toBeEnabled({ timeout: 10_000 })

		await pulseInput.fill('What is going on?')
		await pulseInput.press('Enter')

		// Overlay sheet opens.
		await expect(page.getByRole('heading', { name: 'Sindre' })).toBeVisible({
			timeout: 10_000,
		})

		// The sheet auto-sends the forwarded message to the persistent session.
		await expect
			.poll(() => mocks.inputCalls.map((c) => c.content), { timeout: 10_000 })
			.toContain('What is going on?')

		// Streaming reply renders in the sheet transcript.
		await expect(page.getByText('Hi from Sindre E2E')).toBeVisible({
			timeout: 10_000,
		})
	})

	test('slash picker: two objects multi-select, agent is single-select and re-picks replace', async ({
		page,
		account,
	}) => {
		await installSindreMocks(page, {
			workspaceId: account.workspaceId,
			humanActorId: account.actorId,
			humanActorName: 'E2E Test User',
			extraAgents: [
				{ id: 'agent-atlas', name: 'Atlas' },
				{ id: 'agent-bastion', name: 'Bastion' },
			],
			objects: [
				{ id: 'obj-q-review', title: 'Quarterly Review', type: 'bet' },
				{ id: 'obj-ship-plan', title: 'Shipping Plan', type: 'task' },
			],
		})

		await page.goto(`/${account.workspaceId}`)
		await openSheetFromSidebar(page)

		const sheet = page.locator('[data-surface="sheet"]')
		await expect(sheet).toBeVisible()

		// Picker buttons unlock once the sheet's Sindre session reaches
		// `ready`/`connecting`; wait explicitly so the first click doesn't
		// race the session bootstrap.
		const objectsBtn = sheet.getByRole('button', { name: 'Attach objects' })
		const agentBtn = sheet.getByRole('button', { name: 'Pick an agent' })
		await expect(objectsBtn).toBeEnabled({ timeout: 10_000 })

		// Multi-select: pick two objects, picker stays open between picks.
		await objectsBtn.click()
		await expect(page.locator('[cmdk-item]').first()).toBeVisible({
			timeout: 10_000,
		})
		await page.locator('[cmdk-item]', { hasText: 'Quarterly Review' }).click()
		await page.locator('[cmdk-item]', { hasText: 'Shipping Plan' }).click()
		await page.keyboard.press('Escape')

		const chips = sheet.getByRole('list', { name: 'Selected context' })
		await expect(chips.getByText('Quarterly Review')).toBeVisible()
		await expect(chips.getByText('Shipping Plan')).toBeVisible()

		// Single-select: picking an agent closes the picker.
		await expect(agentBtn).toBeEnabled()
		await agentBtn.click()
		await page.locator('[cmdk-item]', { hasText: 'Atlas' }).click()
		await expect(chips.getByText('Atlas')).toBeVisible()

		// Single-agent rule: re-picking a different agent replaces the first.
		await agentBtn.click()
		await page.locator('[cmdk-item]', { hasText: 'Bastion' }).click()
		await expect(chips.getByText('Bastion')).toBeVisible()
		await expect(chips.getByText('Atlas')).toHaveCount(0)

		// Object selection remains intact across the agent re-pick.
		await expect(chips.getByText('Quarterly Review')).toBeVisible()
		await expect(chips.getByText('Shipping Plan')).toBeVisible()
	})

	test('refresh preserves the transcript: stored sessionId reused, stream resubscribes', async ({
		page,
		account,
	}) => {
		const mocks = await installSindreMocks(page, {
			workspaceId: account.workspaceId,
			humanActorId: account.actorId,
			humanActorName: 'E2E Test User',
			streamEvents: [
				{
					type: 'assistant',
					message: {
						id: 'msg-before-reload',
						content: [{ type: 'text', text: 'Before reload message' }],
					},
				},
			],
		})

		await page.goto(`/${account.workspaceId}`)
		await openSheetFromSidebar(page)

		await expect.poll(() => mocks.sessionsCreated, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
		await expect
			.poll(() => mocks.streamSubscriptions, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(1)

		// The session hook persists the container id in localStorage so the
		// refresh can pick up the running container.
		const storedSessionId = await page.evaluate(
			(ws) => localStorage.getItem(`maskin-sindre-session-${ws}`),
			account.workspaceId,
		)
		expect(storedSessionId).toBe(mocks.sessionId)

		const sessionsBefore = mocks.sessionsCreated
		const subscriptionsBefore = mocks.streamSubscriptions

		await page.reload()
		await openSheetFromSidebar(page)

		// The stored session id is reused — no new session is bootstrapped —
		// and the SSE stream resubscribes on the fresh page instance.
		await expect
			.poll(() => mocks.streamSubscriptions, { timeout: 10_000 })
			.toBeGreaterThan(subscriptionsBefore)
		expect(mocks.sessionsCreated).toBe(sessionsBefore)
	})

	test("a notification's 'Talk to Sindre' action opens the sheet with that notification in context", async ({
		page,
		account,
	}) => {
		const notification = buildNotificationFixture({
			id: 'e2e-notif-1',
			workspaceId: account.workspaceId,
			sourceActorId: account.actorId,
			title: 'Backups failing in prod',
			content: 'Three consecutive nightly backup runs errored out.',
			type: 'alert',
		})

		await installSindreMocks(page, {
			workspaceId: account.workspaceId,
			humanActorId: account.actorId,
			humanActorName: 'E2E Test User',
			notifications: [notification],
		})

		await page.goto(`/${account.workspaceId}`)

		// Switch from the Overview tab to Notifications so the PulseCard
		// renders.
		await page.getByRole('tab', { name: /Notifications/ }).click()
		await expect(page.getByText('Backups failing in prod')).toBeVisible({
			timeout: 10_000,
		})

		await page.getByRole('button', { name: /Talk to Sindre/ }).click()

		await expect(page.getByRole('heading', { name: 'Sindre' })).toBeVisible()

		const chips = page
			.locator('[data-surface="sheet"]')
			.getByRole('list', { name: 'Selected context' })
		await expect(chips.getByText('Backups failing in prod')).toBeVisible()
	})
})
