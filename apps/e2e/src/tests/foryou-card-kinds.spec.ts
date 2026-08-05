import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T3 of bet `foryou-prototype-redesign`: three card kinds with intentionally
// different action-UI weight.
//
// - Decision (task in `in_review` with `metadata.decision_type` set): shaded
//   --st-in_review-bg footer bar with full-width primary/secondary buttons.
//   `in_review` doesn't exist on `bet` in the workspace schema, so decisions
//   ride on tasks the human owns (ux / architecture / copy / pricing).
// - Sign-off (task in `in_review`, no decision_type): flat chip-row inside
//   the card body — an agent asking for a light-touch approval.
// - Proposed-bet (bet in `signal`): flat chip-row inside the card body.
//
// The load-bearing wager is that button-vs-chip weight, as a stakes-signal,
// shifts owners from graph-drop to in-card action. If a reviewer softens the
// distinction (e.g. makes decision buttons chip-sized "for consistency"), this
// spec should trip.
//
// Also locks the T6 contract: `data-card-kind` on the card root and
// `data-action-id` on every affordance so instrumentation can wire without
// restructuring.
//
// T7 rebuilt the feed into a single-card swipeable queue — only the current
// head of the queue is ever mounted (see `ForYouCardQueue`'s `activeItems`).
// So this spec drives the queue with the mutation-free "Keep unread" control
// (`ForYouQueueCardHandle.skip`) to walk through all three kinds one at a
// time, rather than asserting all three are on screen simultaneously.

interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentioning_unread_count: number
	latest_event_id: number
	latest_activity_at: string
	object: {
		id: string
		title: string
		type: string
		status: string
		content: string
		workspaceId: string
		metadata?: Record<string, string> | null
	}
}

function buildItem(
	workspaceId: string,
	entityId: string,
	type: string,
	status: string,
	title: string,
	metadata: Record<string, string> | null = null,
): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: entityId,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: new Date().toISOString(),
		object: { id: entityId, title, type, status, content: '', workspaceId, metadata },
	}
}

async function mockThreeKinds(page: Page, workspaceId: string) {
	const items = [
		// Decision → task in in_review with a decision_type (ux/architecture/copy/pricing).
		// The bet schema has no `in_review` status, so decisions live on tasks the human owns.
		buildItem(workspaceId, 'task-decision', 'task', 'in_review', 'Approve migration playbook', {
			decision_type: 'architecture',
		}),
		// Sign-off → task in in_review with no decision_type (agent asking for rubber-stamp).
		buildItem(workspaceId, 'task-signoff', 'task', 'in_review', 'Wire acquisition source'),
		buildItem(workspaceId, 'bet-proposed', 'bet', 'signal', 'Onboarding checklist redesign'),
	]
	await page.route('**/api/subscriptions/unread*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

// Advances the single-card queue via the mutation-free "Keep unread" control
// so the next item becomes the current (and only) mounted card.
async function skipCurrentCard(page: Page) {
	await page.getByRole('button', { name: 'Keep unread' }).click()
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`For You — three card kinds @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('cycles decision, sign_off, and proposed_bet with kind-specific affordances', async ({
			page,
			account,
		}) => {
			await mockThreeKinds(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			// The single-card queue only ever mounts the current head — never all
			// three kinds at once.
			await expect(page.locator('[data-card-kind]')).toHaveCount(1)

			// 1. Decision (queue head) → shaded footer with Approve + Send back.
			const decision = page.locator('[data-card-kind="decision"]')
			await expect(decision).toHaveCount(1)
			const decisionBlock = decision.getByTestId('decision-block')
			await expect(decisionBlock).toBeVisible()
			await expect(decisionBlock).toHaveClass(/bg-status-in_review-bg/)
			await expect(decision.getByRole('button', { name: 'Approve' })).toBeVisible()
			await expect(decision.getByRole('button', { name: 'Send back' })).toBeVisible()
			// Decision cards must NOT render the flat chip-row — the shaded
			// footer IS their action zone. Softening this defeats the bet.
			await expect(decision.getByTestId('chip-row')).toHaveCount(0)

			// 2. Sign-off → flat chip-row, NO shaded footer.
			await skipCurrentCard(page)
			const signOff = page.locator('[data-card-kind="sign_off"]')
			await expect(signOff).toHaveCount(1)
			await expect(signOff.getByTestId('chip-row')).toBeVisible()
			await expect(signOff.getByTestId('decision-block')).toHaveCount(0)
			await expect(signOff.getByRole('button', { name: 'Sign off' })).toBeVisible()
			await expect(signOff.getByRole('button', { name: 'Snooze 24h' })).toBeVisible()

			// 3. Proposed-bet → flat chip-row, NO shaded footer.
			await skipCurrentCard(page)
			const proposedBet = page.locator('[data-card-kind="proposed_bet"]')
			await expect(proposedBet).toHaveCount(1)
			await expect(proposedBet.getByTestId('chip-row')).toBeVisible()
			await expect(proposedBet.getByTestId('decision-block')).toHaveCount(0)
			await expect(proposedBet.getByRole('button', { name: 'Open bet' })).toBeVisible()
			await expect(proposedBet.getByRole('button', { name: 'Refine first' })).toBeVisible()
		})

		test('exposes stable data-action-id on every affordance so T6 can instrument without restructuring', async ({
			page,
			account,
		}) => {
			await mockThreeKinds(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const decision = page.locator('[data-card-kind="decision"]')
			await expect(decision.locator('[data-action-id="approve"]')).toBeVisible()
			await expect(decision.locator('[data-action-id="send_back"]')).toBeVisible()

			await skipCurrentCard(page)
			const signOff = page.locator('[data-card-kind="sign_off"]')
			await expect(signOff.locator('[data-action-id="sign_off"]')).toBeVisible()

			await skipCurrentCard(page)
			const proposedBet = page.locator('[data-card-kind="proposed_bet"]')
			await expect(proposedBet.locator('[data-action-id="open_bet"]')).toBeVisible()
		})
	})
}
