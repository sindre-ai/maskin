import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T3 of bet `foryou-prototype-redesign`: three card kinds with intentionally
// different action-UI weight.
//
// - Decision (bet in `in_review`): shaded --st-in_review-bg footer bar with
//   full-width primary/secondary buttons.
// - Sign-off (task in `in_review`): flat chip-row inside the card body.
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
	}
}

function buildItem(
	workspaceId: string,
	entityId: string,
	type: string,
	status: string,
	title: string,
): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: entityId,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: new Date().toISOString(),
		object: { id: entityId, title, type, status, content: '', workspaceId },
	}
}

async function mockThreeKinds(page: Page, workspaceId: string) {
	const items = [
		buildItem(workspaceId, 'bet-decision', 'bet', 'in_review', 'Recover failed payments'),
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

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`For You — three card kinds @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('renders decision, sign_off, and proposed_bet with kind-specific affordances', async ({
			page,
			account,
		}) => {
			await mockThreeKinds(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			// One card per kind, each exposing data-card-kind for T6.
			const decision = page.locator('[data-card-kind="decision"]')
			const signOff = page.locator('[data-card-kind="sign_off"]')
			const proposedBet = page.locator('[data-card-kind="proposed_bet"]')

			await expect(decision).toHaveCount(1)
			await expect(signOff).toHaveCount(1)
			await expect(proposedBet).toHaveCount(1)

			// Decision → shaded footer with Approve + Send back.
			const decisionFooter = decision.getByTestId('decision-footer')
			await expect(decisionFooter).toBeVisible()
			await expect(decisionFooter).toHaveClass(/bg-status-in_review-bg/)
			await expect(decision.getByRole('button', { name: 'Approve' })).toBeVisible()
			await expect(decision.getByRole('button', { name: 'Send back' })).toBeVisible()
			// Decision cards must NOT render the flat chip-row — the shaded
			// footer IS their action zone. Softening this defeats the bet.
			await expect(decision.getByTestId('chip-row')).toHaveCount(0)

			// Sign-off → flat chip-row, NO shaded footer.
			await expect(signOff.getByTestId('chip-row')).toBeVisible()
			await expect(signOff.getByTestId('decision-footer')).toHaveCount(0)
			await expect(signOff.getByRole('button', { name: 'Sign off' })).toBeVisible()
			await expect(signOff.getByRole('button', { name: 'Snooze 24h' })).toBeVisible()

			// Proposed-bet → flat chip-row, NO shaded footer.
			await expect(proposedBet.getByTestId('chip-row')).toBeVisible()
			await expect(proposedBet.getByTestId('decision-footer')).toHaveCount(0)
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

			const signOff = page.locator('[data-card-kind="sign_off"]')
			await expect(signOff.locator('[data-action-id="sign_off"]')).toBeVisible()

			const proposedBet = page.locator('[data-card-kind="proposed_bet"]')
			await expect(proposedBet.locator('[data-action-id="open_bet"]')).toBeVisible()
		})
	})
}
