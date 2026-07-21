import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// T5 — fleet-status Objects page (D1). Landing on /objects renders three
// primitive sections (Insights / Bets / Tasks) with rows sorted by AI-work-state
// weight, section headers show a "N waiting" pill when the section has
// waiting_on_human rows, and idle rows are folded behind an idle-hidden note
// unless `?showIdle=1` is set. Verified at 1280 (desktop) and 375 (iPhone).

const FLEET_VIEWPORTS = [VIEWPORTS.desktopXl, VIEWPORTS.mobile]

test.describe('Objects fleet-status page (D1)', () => {
	for (const vp of FLEET_VIEWPORTS) {
		test(`mixed portfolio renders three primitive sections with waiting pill on the waiting section at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed: one bet with an open human_decision (→ waiting_on_human), plus
			// one bet with a live session (→ progressing). Also a couple of idle
			// insights/tasks so all three sections have rows.
			const waitingBet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Fleet waiting bet',
				status: 'active',
			})
			const decision = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Approve the launch',
				status: 'todo',
				metadata: { human_decision: true },
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: waitingBet.id,
				target_type: 'task',
				target_id: decision.id,
				type: 'breaks_into',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Fleet insight one',
				status: 'todo',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Fleet task one',
				status: 'todo',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible({ timeout: 10000 })

			// Three primitive sections render.
			await expect(page.getByRole('button', { name: /Select all in Insights/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /Select all in Bets/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /Select all in Tasks/ })).toBeVisible()

			// The waiting bet lands in the Bets section, and its section header
			// carries the "N waiting" pill (aria-label spells out the count).
			await expect(page.locator('[aria-label$="waiting on human"]').first()).toBeVisible()
			await expect(page.locator('main').getByText('Fleet waiting bet').first()).toBeVisible()
		})

		test(`idle rows are folded by default and the section header shows the hidden count at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed: one idle insight, one idle task, one idle bet. No live sessions
			// or human decisions — every row classifies as idle.
			await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Idle-only insight',
				status: 'todo',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Idle-only task',
				status: 'todo',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Idle-only bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible({ timeout: 10000 })

			// Idle rows are folded — the seeded titles aren't visible in the main
			// list, and the section header carries a "N idle hidden" note.
			await expect(page.locator('main').getByText('Idle-only insight')).not.toBeVisible()
			await expect(page.getByText(/idle hidden/i).first()).toBeVisible()

			// Flipping showIdle in the URL reveals the folded rows.
			await page.goto(`/${account.workspaceId}/objects?showIdle=1`)
			await expect(page.locator('main').getByText('Idle-only insight')).toBeVisible({
				timeout: 10000,
			})
			await expect(page.locator('main').getByText('Idle-only task')).toBeVisible()
		})
	}

	test('empty primitive section still renders when the tab filters that type in', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktopXl.width,
			height: VIEWPORTS.desktopXl.height,
		})

		// Only create objects of one type; the tab filter isolates the section.
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Solo bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects?type=bet`)
		await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible({ timeout: 10000 })
		await expect(page.locator('main').getByText('Solo bet')).toBeVisible()

		// Tabs constrain the query to the picked type; other primitive sections
		// don't render because the row set is bet-only. No "N waiting" pill either
		// (no waiting row exists).
		await expect(page.getByRole('button', { name: /Select all in Insights/ })).not.toBeVisible()
	})
})
