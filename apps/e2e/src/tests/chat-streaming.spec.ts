import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { installChatMocks } from '../helpers/chat.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for T4 — the typing indicator and streaming session chip.
 * These render while a live assistant turn is in flight (post-send,
 * pre-first-envelope) so the user sees which agent is working, what verb,
 * how long it's been running, and can single-tap Stop to halt the stream.
 *
 * Runs at all three ship-gate viewports (375 / 768 / 1024) so we catch any
 * mobile collapse regression on the streaming controls.
 */

async function openChatPanel(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/objects`)
	await page.getByRole('button', { name: /^new$/i }).click()
	await page.getByRole('menuitem', { name: /new chat/i }).click()
	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })
}

/**
 * Overrides `installChatMocks`'s SSE route with an empty-body stream that
 * stays open for the duration of the test — no assistant envelopes arrive so
 * the turn stays pending and the streaming chip stays visible.
 */
async function keepStreamOpen(page: Page, sessionId: string) {
	await page.route(`**/api/sessions/${sessionId}/logs/stream`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
			body: 'retry: 600000\n\n',
		})
	})
}

/** Captures POST /api/sessions/:id/stop calls so we can assert Stop worked. */
async function installStopMock(
	page: Page,
	sessionId: string,
	workspaceId: string,
): Promise<{ calls: number }> {
	const state = { calls: 0 }
	await page.route(`**/api/sessions/${sessionId}/stop`, async (route: Route) => {
		if (route.request().method() !== 'POST') return route.fallback()
		state.calls += 1
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: sessionId,
				workspaceId,
				status: 'completed',
				actorId: 'e2e-agent-actor',
			}),
		})
	})
	return state
}

test.describe('Chat streaming controls', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`typing indicator and Stop work at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const mocks = await installChatMocks(page, {
				workspaceId: account.workspaceId,
				humanActorId: account.actorId,
				humanActorName: 'E2E Test User',
			})
			const stop = await installStopMock(page, mocks.sessionId, account.workspaceId)
			// Register the empty-stream override AFTER installChatMocks so it
			// wins (Playwright picks the most recently registered matching route).
			await keepStreamOpen(page, mocks.sessionId)

			await openChatPanel(page, account.workspaceId)

			const input = page.getByPlaceholder('Message agents')
			await expect(input).toBeEnabled({ timeout: 10_000 })
			await input.fill('Get me a read on Q3 retention')
			await input.press('Enter')

			// The persistent session receives the user turn.
			await expect
				.poll(() => mocks.inputCalls.map((c) => c.content), { timeout: 10_000 })
				.toContain('Get me a read on Q3 retention')

			// The streaming chip appears in the sheet — typing indicator
			// (agent name + verb) plus a single-tap Stop control.
			const sheet = page.locator('[data-surface="sheet"]')
			const chip = sheet.locator('[data-streaming-session-chip]')
			await expect(chip).toBeVisible({ timeout: 10_000 })
			await expect(chip.getByText('Workspace Coach')).toBeVisible()

			const stopButton = chip.getByRole('button', { name: /Stop streaming/i })
			await expect(stopButton).toBeVisible()

			// Tap Stop — the API is hit, the chip flips to "Stopped", and no
			// further output can be produced from that session.
			await stopButton.click()
			await expect.poll(() => stop.calls, { timeout: 10_000 }).toBe(1)
			await expect(sheet.getByText('Stopped')).toBeVisible({ timeout: 10_000 })
			await expect(stopButton).not.toBeVisible()

			// Composer stays usable after a stop — the next turn can be sent
			// without a page reload (the session's status flips to `closed` on
			// the next send, triggering a fresh session).
			await expect(input).toBeEnabled({ timeout: 10_000 })
		})
	}
})
