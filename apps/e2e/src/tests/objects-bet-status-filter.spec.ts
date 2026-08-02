import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// T3: the DisplayPanel gains a "Bet status" filter row on the bets tab. Multi-
// select over the four `classifyBetStatus()` states (idle / stalled /
// progressing / waiting_on_human). State is URL-synced via `?betStatus=`
// so the setting deep-links. Client-side only — the filter reslices the
// already-loaded rows against the classifier map, no server round-trip.
test.describe('Objects — Bet status filter', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`narrows the bets list by picked classifier state @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Two bets that land on different classifier states:
			// - "waiting_on_human" — bet with an open task carrying human_decision
			// - "idle" — bet with a lone todo task, no session and no human ping
			// This gives us one bet per state so each filter pick is a real narrow.
			const waitingTitle = `Waiting bet ${Date.now()}`
			const idleTitle = `Idle bet ${Date.now()}`
			const waitingBet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: waitingTitle,
				status: 'active',
			})
			const decision = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Approve rollout',
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
			const idleBet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: idleTitle,
				status: 'active',
			})
			const idleTask = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Later work',
				status: 'todo',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: idleBet.id,
				target_type: 'task',
				target_id: idleTask.id,
				type: 'breaks_into',
			})

			// Default state on the bet tab shows both.
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText(waitingTitle)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText(idleTitle)).toBeVisible()

			// Open the DisplayPanel and pick "waiting on human".
			await page.getByRole('button', { name: /^Display/ }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Bet status')).toBeVisible()
			await dialog.getByRole('button', { name: /\+ Bet status/i }).click()
			await page.getByRole('menuitemcheckbox', { name: 'waiting on human' }).click()
			await page.keyboard.press('Escape')

			// URL now carries the picked value; only the waiting bet remains visible.
			await expect(page).toHaveURL(/betStatus=waiting_on_human/)
			await expect(page.getByText(waitingTitle)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText(idleTitle)).toHaveCount(0)

			// Widen the pick — add "idle". Both classes should now appear.
			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('dialog').getByRole('button', { name: /waiting on human/i }).click()
			await page.getByRole('menuitemcheckbox', { name: 'idle' }).click()
			await page.keyboard.press('Escape')

			await expect(page).toHaveURL(/betStatus=(waiting_on_human%2Cidle|idle%2Cwaiting_on_human)/)
			await expect(page.getByText(waitingTitle)).toBeVisible()
			await expect(page.getByText(idleTitle)).toBeVisible()

			// Clear — deselect both from the panel and the URL param drops.
			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('dialog').getByRole('button', { name: /2 bet statuses/i }).click()
			await page.getByRole('menuitemcheckbox', { name: 'idle' }).click()
			await page.getByRole('menuitemcheckbox', { name: 'waiting on human' }).click()
			await page.keyboard.press('Escape')

			await expect(page).not.toHaveURL(/betStatus=/)
			await expect(page.getByText(waitingTitle)).toBeVisible()
			await expect(page.getByText(idleTitle)).toBeVisible()
		})
	}

	// The chip strip surfaces the picked values as a removable pill at desktop
	// widths. Exercised at 1024 (iPad landscape — the smallest ship-gate
	// viewport that still renders the desktop chip row).
	test(`surfaces the pick as a chip and removes it via the chip's ✕ @ ${VIEWPORTS.tabletLandscape.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})

		const waitingTitle = `Chip waiting bet ${Date.now()}`
		const idleTitle = `Chip idle bet ${Date.now()}`
		const waitingBet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: waitingTitle,
			status: 'active',
		})
		const decision = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Approve rollout',
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
		const idleBet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: idleTitle,
			status: 'active',
		})
		const idleTask = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Later idle work',
			status: 'todo',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'bet',
			source_id: idleBet.id,
			target_type: 'task',
			target_id: idleTask.id,
			type: 'breaks_into',
		})

		// Deep-link with the filter already picked so we're testing the chip,
		// not the picker plumbing.
		await page.goto(`/${account.workspaceId}/objects?type=bet&betStatus=waiting_on_human`)
		await expect(page.getByText(waitingTitle)).toBeVisible({ timeout: 10_000 })
		await expect(page.getByText(idleTitle)).toHaveCount(0)

		const chip = page.getByText('Bet status:').locator('..')
		await expect(chip).toBeVisible()
		await expect(chip).toContainText('waiting on human')

		await page.getByRole('button', { name: /Remove Bet status filter/i }).click()

		// URL loses the flag, idle bet reappears alongside waiting.
		await expect(page).not.toHaveURL(/betStatus=/)
		await expect(page.getByText(waitingTitle)).toBeVisible()
		await expect(page.getByText(idleTitle)).toBeVisible()
	})

	test('does not surface the Bet-status row on tabs where bets never appear (Tasks)', async ({
		page,
		account,
	}) => {
		await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Standalone task',
			status: 'todo',
		})

		await page.goto(`/${account.workspaceId}/objects?type=task`)
		await expect(page.getByText('Standalone task')).toBeVisible({ timeout: 10_000 })

		await page.getByRole('button', { name: /^Display/ }).click()
		// Filters section is present but "Bet status" is not one of the rows.
		await expect(page.getByRole('dialog').getByText('Bet status')).toHaveCount(0)
	})
})
