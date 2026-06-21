import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { buildNotificationFixture, installSindreMocks } from '../helpers/sindre.helper'

/**
 * E2E coverage for the Sindre chat surfaces:
 *   1. Opening the Sindre panel via the header button and sending a message
 *      that the persistent session receives; the transcript shows a streamed reply.
 *   2. Slash picker multi-selects two objects, single-selects one agent,
 *      and a second agent pick replaces the first (single-agent rule).
 *   3. Refresh bootstraps a new session and the stream resubscribes.
 *   4. A PulseCard's "Talk to Sindre" action opens the sheet with the
 *      originating notification seeded as a selection chip.
 *
 * All tests mock the Sindre session + SSE surface so the specs do not
 * require a live Docker-backed interactive session; the real backend is
 * still used for auth, workspaces, and anything else not explicitly
 * intercepted.
 */

async function openSheetFromSidebar(page: Page) {
	await page.getByRole('button', { name: 'Open Sindre' }).click()
	await expect(page.getByRole('heading', { name: 'Sindre' })).toBeVisible()
}

test.describe('Sindre chat surfaces', () => {
	test('header button opens sindre panel and streams reply', async ({ page, account }) => {
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

		// Open the Sindre panel via the header button
		await page.getByRole('button', { name: 'Open Sindre' }).click()
		await expect(page.getByRole('heading', { name: 'Sindre' })).toBeVisible({
			timeout: 10_000,
		})

		// Wait for the session to bootstrap and the input to become usable
		const input = page.getByPlaceholder('Message Sindre')
		await expect(input).toBeEnabled({ timeout: 10_000 })

		await input.fill('What is going on?')
		await input.press('Enter')

		// The persistent session receives the forwarded message.
		await expect
			.poll(() => mocks.inputCalls.map((c) => c.content), { timeout: 10_000 })
			.toContain('What is going on?')

		// Streaming reply renders in the transcript.
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

	test('refresh bootstraps a fresh session and resubscribes the stream', async ({
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

		// Session id is tab-scoped React state — no localStorage persistence.
		// Refreshing the page bootstraps a new interactive session and the
		// watchdog pauses the old one on idle.
		const storedSessionId = await page.evaluate(
			(ws) => localStorage.getItem(`maskin-sindre-session-${ws}`),
			account.workspaceId,
		)
		expect(storedSessionId).toBeNull()

		const sessionsBefore = mocks.sessionsCreated
		const subscriptionsBefore = mocks.streamSubscriptions

		await page.reload()
		await openSheetFromSidebar(page)

		// A fresh session is bootstrapped and the SSE stream resubscribes on
		// the new page instance.
		await expect
			.poll(() => mocks.sessionsCreated, { timeout: 10_000 })
			.toBeGreaterThan(sessionsBefore)
		await expect
			.poll(() => mocks.streamSubscriptions, { timeout: 10_000 })
			.toBeGreaterThan(subscriptionsBefore)
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
