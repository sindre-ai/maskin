import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { type NamedViewport, VIEWPORTS } from '../helpers/viewports'

/**
 * The chat Overview opens as a persistent right rail only from 1280px up. At 1024 with the app
 * sidebar open a fixed 400px rail left the chat column about 142px wide and the transcript
 * scrolled sideways, so from 1024 to 1279 (and below) it opens as a bottom sheet instead.
 *
 * The conversation carries a long agent message (a wide table and a long unbroken URL), the
 * content that overflowed in the report.
 */

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1
const MIN_CHAT_COLUMN_PX = 480
const RAIL_WIDTH_PX = 440

const LONG_UNBROKEN_URL =
	'https://internal.example.com/reports/2026/10/overview-rail-cohort-split-by-activation-source-seat-count'

const LONG_AGENT_MESSAGE = [
	'Here is the full breakdown you asked for, with every segment and the evidence behind it.',
	'',
	'| Signal | Segment | Owner | Confidence | Evidence | Next check |',
	'| --- | --- | --- | --- | --- | --- |',
	'| Enterprise onboarding drop-off | Self-serve mid-market accounts | Release Verifier | 0.62 | Step 2 abandons at 3x the baseline rate across every activation cohort this quarter | Re-run the cohort split once the next deploy lands |',
	'',
	LONG_UNBROKEN_URL,
].join('\n')

async function openLongMessageChat(
	page: Page,
	account: { workspaceId: string; api: TestAPI },
	viewport: NamedViewport,
) {
	await page.setViewportSize({ width: viewport.width, height: viewport.height })
	const agent = await account.api.createAgentActor(`Overview Rail QA ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E overview rail',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
		content: LONG_AGENT_MESSAGE,
	})

	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	const thread = page.getByTestId('thread-messages')
	await expect(thread).toBeVisible({ timeout: 10_000 })
	await expect(thread).toContainText(LONG_UNBROKEN_URL, { timeout: 10_000 })
	await page.getByRole('button', { name: 'Open Overview' }).click()
	return thread
}

async function assertNoTranscriptOverflow(page: Page, label: string) {
	await page.waitForTimeout(300)
	const report = await page.evaluate(() => {
		const scroller = document.querySelector('[data-testid="thread-messages"]')
		return {
			scrollerClientWidth: scroller?.clientWidth ?? 0,
			scrollerScrollWidth: scroller?.scrollWidth ?? 0,
			docScrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}
	})
	expect(
		report.scrollerScrollWidth,
		`${label}: transcript scrolls sideways (scrollWidth ${report.scrollerScrollWidth} > clientWidth ${report.scrollerClientWidth})`,
	).toBeLessThanOrEqual(report.scrollerClientWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)
	expect(report.docScrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(
		report.innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX,
	)
}

test.describe('Chat — Overview rail width', () => {
	test('at 1024 the Overview opens as a sheet and the chat keeps its width', async ({
		page,
		account,
	}) => {
		const thread = await openLongMessageChat(page, account, VIEWPORTS.tabletLandscape)

		await expect(page.getByRole('dialog', { name: 'Overview' })).toBeVisible()
		await expect(page.getByLabel('Overview pane')).toHaveCount(0)

		const box = await thread.boundingBox()
		expect(
			box?.width ?? 0,
			'chat column width at 1024 with the Overview open',
		).toBeGreaterThanOrEqual(MIN_CHAT_COLUMN_PX)
		await assertNoTranscriptOverflow(page, 'Overview open @ 1024')
	})

	for (const viewport of [VIEWPORTS.desktopXl, VIEWPORTS.desktop]) {
		test(`at ${viewport.width} the persistent rail is unchanged`, async ({ page, account }) => {
			const thread = await openLongMessageChat(page, account, viewport)

			const rail = page.getByLabel('Overview pane')
			await expect(rail).toBeVisible()
			await expect(page.getByRole('dialog', { name: 'Overview' })).toHaveCount(0)

			const railBox = await rail.boundingBox()
			expect(railBox?.width ?? 0, `rail width @ ${viewport.width}`).toBe(RAIL_WIDTH_PX)
			await expect(thread).toBeVisible()
			await assertNoTranscriptOverflow(page, `Overview open @ ${viewport.width}`)
		})
	}

	test('at 375 the Overview is still a sheet', async ({ page, account }) => {
		await openLongMessageChat(page, account, VIEWPORTS.mobile)

		await expect(page.getByRole('dialog', { name: 'Overview' })).toBeVisible()
		await expect(page.getByLabel('Overview pane')).toHaveCount(0)
		await assertNoTranscriptOverflow(page, 'Overview open @ 375')
	})
})
