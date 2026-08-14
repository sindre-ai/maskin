import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You draft-card + starter-card wiring for signup-driven workspaces
// (task T3 of the signup-research-council bet).
//
// The signup pipeline is mocked at the /api/objects boundary so the spec
// stays deterministic without needing a running knowledge-write trigger.
// Two knowledge/bet fixtures cover the three branches:
//   - signup workspace + qualified draft bet  → SignupDraftCard renders.
//   - signup workspace + no draft             → SignupStarterCard renders.
//   - non-signup workspace                    → neither card renders (regression).
//
// The bet's PostHog event (`qualified_bet_visible`) fires on mount of the
// draft card; PostHog capture is asserted via a network intercept.

type Metadata = Record<string, unknown> | null

interface ObjectFixture {
	id: string
	workspaceId: string
	type: string
	title: string
	content: string | null
	status: string
	metadata: Metadata
	driver: unknown
	activeSessionId: string | null
	createdBy: string
	createdAt: string
	updatedAt: string | null
}

function buildKnowledge(workspaceId: string): ObjectFixture {
	return {
		id: `knowledge-signup-capture-${workspaceId}`,
		workspaceId,
		type: 'knowledge',
		title: 'Signup context — Test',
		content: null,
		status: 'validated',
		metadata: { source: 'signup_capture' },
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: null,
	}
}

function buildDraftBet(workspaceId: string): ObjectFixture {
	return {
		id: `bet-signup-draft-${workspaceId}`,
		workspaceId,
		type: 'bet',
		title: 'Ship a smaller launch to your beachhead segment',
		content: null,
		status: 'qualified',
		metadata: { source: 'signup_first_bet_draft' },
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: null,
	}
}

// Route both the plain /api/objects list AND the filtered ones (metadata.source=…)
// so the app's server-side metadata filter still gets a deterministic answer.
async function mockObjects(page: Page, opts: { isSignup: boolean; draftBet: boolean }) {
	await page.route('**/api/objects?*', async (route) => {
		const url = new URL(route.request().url())
		const type = url.searchParams.get('type')
		const source = url.searchParams.get('metadata.source')
		const status = url.searchParams.get('status')
		const workspaceId = route.request().headers()['x-workspace-id'] ?? 'ws-e2e'

		const rows: ObjectFixture[] = []
		if (type === 'knowledge' && source === 'signup_capture') {
			if (opts.isSignup) rows.push(buildKnowledge(workspaceId))
		} else if (type === 'bet' && source === 'signup_first_bet_draft' && status === 'qualified') {
			if (opts.draftBet) rows.push(buildDraftBet(workspaceId))
		} else if (type === 'bet') {
			// useBets(workspaceId) fetches every bet — return the draft when present
			// so the North Star prompt (guarded by bets.length === 0) stays off.
			if (opts.draftBet) rows.push(buildDraftBet(workspaceId))
		}

		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(rows),
		})
	})
	// Keep the unread feed empty so the queue never displaces the card.
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})
}

test.describe('Signup first bet — For You cards', () => {
	test('signup workspace with a qualified draft renders the draft card (AC-U1..U4)', async ({
		page,
		account,
	}) => {
		await mockObjects(page, { isSignup: true, draftBet: true })
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('signup-draft-card')
		await expect(card).toBeVisible()
		await expect(card).toContainText('Drafted for your first session')
		await expect(card.getByRole('button', { name: 'Accept' })).toBeVisible()
		await expect(card.getByRole('button', { name: 'Edit' })).toBeVisible()
		await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible()
		// Sparse composer + North Star are suppressed while the draft card owns
		// the top-of-feed slot.
		await expect(page.getByTestId('sparse-composer')).toHaveCount(0)
	})

	test('signup workspace with sparse research (no draft) renders the starter card (AC-U7/U8)', async ({
		page,
		account,
	}) => {
		await mockObjects(page, { isSignup: true, draftBet: false })
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('signup-starter-card')
		await expect(card).toBeVisible()
		await expect(card).toContainText('Strategist')
		await expect(card).toContainText('What would you like to create?')
		await expect(card.getByLabel('Reply to the Strategist')).toBeVisible()
	})

	test('non-signup workspace renders neither signup card (regression)', async ({
		page,
		account,
	}) => {
		await mockObjects(page, { isSignup: false, draftBet: false })
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-redesign-root')).toBeVisible()
		await expect(page.getByTestId('signup-draft-card')).toHaveCount(0)
		await expect(page.getByTestId('signup-starter-card')).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`draft card fits within ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockObjects(page, { isSignup: true, draftBet: true })
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('signup-draft-card')
			await expect(card).toBeVisible()
			const box = await card.boundingBox()
			if (!box) throw new Error(`draft card has no layout box at ${viewport.label}`)
			expect(box.x).toBeGreaterThanOrEqual(0)
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
		})
	}

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`starter card composer reachable at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockObjects(page, { isSignup: true, draftBet: false })
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('signup-starter-card')
			await expect(card).toBeVisible()
			await expect(card.getByLabel('Reply to the Strategist')).toBeVisible()
		})
	}
})
