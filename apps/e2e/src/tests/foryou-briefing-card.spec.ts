import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Featured briefing card at the top of For You (T4 / bet fyp-briefing-first).
//
// DoD 1  — renders as the first item of the feed when a briefing exists, absent
//          (not a placeholder) when the API returns no briefing.
// DoD 2  — kicker + audio play control + duration + prose bullets + unread-since
//          badge + "continue to feed" chevron.
// DoD 3  — deep-link chips embedded in the prose navigate to their referenced
//          object page.
// DoD 8  — coverage at 1280 and 375 for both states.
//
// The API responses are mocked so the layout and interactions are asserted
// against a deterministic payload — the T3 route contract is covered separately
// in `apps/dev/src/__tests__/routes/briefing.test.ts`.

interface BriefingObjectFixture {
	id: string
	workspaceId: string
	type: 'knowledge'
	title: string
	content: string
	status: string
	metadata: Record<string, unknown> | null
	driver: string | null
	activeSessionId: string | null
	createdBy: string
	createdAt: string
	updatedAt: string
}

interface BriefingPayload {
	object: BriefingObjectFixture | null
	audioFileId: string | null
	unreadDelta: number
}

const BRIEFING_ID = '11111111-1111-1111-1111-111111111111'
const FILE_ID = '22222222-2222-2222-2222-222222222222'
const BET_ID = '33333333-3333-3333-3333-333333333333'
const TASK_ID = '44444444-4444-4444-4444-444444444444'
const INSIGHT_ID = '55555555-5555-5555-5555-555555555555'

function buildBriefingObject(workspaceId: string): BriefingObjectFixture {
	return {
		id: BRIEFING_ID,
		workspaceId,
		type: 'knowledge',
		title: 'Daily briefing',
		content: [
			`- Bet update: [Featured briefing card](/${workspaceId}/objects/${BET_ID})`,
			`- Task in flight: [Wire the read surface](/${workspaceId}/objects/${TASK_ID})`,
			`- Insight to weigh: [Owner attention flow](/${workspaceId}/objects/${INSIGHT_ID})`,
		].join('\n'),
		status: 'validated',
		metadata: { kind: 'briefing' },
		driver: null,
		activeSessionId: null,
		createdBy: '00000000-0000-0000-0000-000000000000',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

async function mockBriefing(page: Page, payload: BriefingPayload) {
	await page.route('**/api/briefing/latest*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(payload),
		})
	})
	// A minimal 1x1 MP3 encoded as base64 — the audio bytes don't matter here,
	// the file endpoint just needs to serve a shape matching FileDetail.
	await page.route(`**/api/files/${FILE_ID}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: FILE_ID,
				workspaceId: payload.object?.workspaceId ?? '',
				name: 'briefing.mp3',
				description: null,
				mimeType: 'audio/mpeg',
				sizeBytes: 8,
				storageKey: 'briefings/mock.mp3',
				createdBy: '00000000-0000-0000-0000-000000000000',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				content: 'AAAAAAAAAA==',
				encoding: 'base64',
				url: `/api/files/${FILE_ID}/download`,
				annotations: [],
			}),
		})
	})
	// Empty unread feed so the briefing card is the first meaningful item.
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})
	// Cards fetch entity events for their thread; empty is fine for layout.
	await page.route('**/api/events*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

test.describe('For You featured briefing card', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the briefing card as the first item at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockBriefing(page, {
				object: buildBriefingObject(account.workspaceId),
				audioFileId: FILE_ID,
				unreadDelta: 4,
			})
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('briefing-card')
			await expect(card).toBeVisible()
			await expect(card.getByText('Briefing')).toBeVisible()
			await expect(card.getByRole('heading', { name: 'Daily briefing' })).toBeVisible()
			await expect(card.getByText('4 new since last briefing')).toBeVisible()

			// Filled play control renders (not a spinner) because audio is
			// pre-rendered by the T2 pipeline.
			await expect(card.getByRole('button', { name: /play briefing audio/i })).toBeVisible()
			await expect(card.getByRole('button', { name: /play briefing audio/i })).toBeEnabled()

			// Three deep-link chips embedded in the prose.
			await expect(card.getByRole('link', { name: 'Featured briefing card' })).toHaveAttribute(
				'href',
				`/${account.workspaceId}/objects/${BET_ID}`,
			)
			await expect(card.getByRole('link', { name: 'Wire the read surface' })).toHaveAttribute(
				'href',
				`/${account.workspaceId}/objects/${TASK_ID}`,
			)
			await expect(card.getByRole('link', { name: 'Owner attention flow' })).toHaveAttribute(
				'href',
				`/${account.workspaceId}/objects/${INSIGHT_ID}`,
			)

			// Continue-to-feed affordance sits at the footer.
			await expect(card.getByRole('button', { name: 'Continue to feed' })).toBeVisible()
		})

		test(`omits the card entirely when no briefing exists at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockBriefing(page, { object: null, audioFileId: null, unreadDelta: 0 })
			await page.goto(`/${account.workspaceId}`)

			// Empty-state chrome renders normally, briefing card is absent
			// (not a placeholder).
			await expect(page.getByText('All caught up')).toBeVisible()
			await expect(page.getByTestId('briefing-card')).toHaveCount(0)
		})
	}

	test('deep-link chip navigation resolves to the referenced object page', async ({
		page,
		account,
	}) => {
		await mockBriefing(page, {
			object: buildBriefingObject(account.workspaceId),
			audioFileId: FILE_ID,
			unreadDelta: 2,
		})
		// Reused across the three chip clicks: the object detail route calls
		// `/api/objects/:id/graph`; a minimal 200 keeps navigation deterministic.
		await page.route('**/api/objects/*/graph*', async (route) => {
			const url = route.request().url()
			const match = url.match(/\/api\/objects\/([0-9a-f-]{36})\/graph/)
			const id = match?.[1] ?? BET_ID
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					object: {
						id,
						workspaceId: account.workspaceId,
						type: 'bet',
						title: `Chip destination ${id.slice(0, 4)}`,
						content: null,
						status: 'active',
						metadata: null,
						driver: null,
						activeSessionId: null,
						createdBy: '00000000-0000-0000-0000-000000000000',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
					relationships: [],
					connected_objects: [],
				}),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('briefing-card')
		await expect(card).toBeVisible()

		for (const [chipName, expectedId] of [
			['Featured briefing card', BET_ID],
			['Wire the read surface', TASK_ID],
			['Owner attention flow', INSIGHT_ID],
		] as const) {
			await card.getByRole('link', { name: chipName }).click()
			await expect(page).toHaveURL(new RegExp(`/objects/${expectedId}$`))
			await page.goBack()
			await expect(card).toBeVisible()
		}
	})
})
