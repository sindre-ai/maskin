import { expect, test } from '../fixtures/auth.fixture'
import { createTestActor } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T2 follow-up: the List row shows a pending-ask line ("<Agent> asks · <ask>")
// and a "Waiting on you" pill while a needs_input notification targeting the
// object is still pending. The pill is `bg-accent text-accent-foreground` (the
// established accent-pairing rule), so it must be legible in both colour
// schemes at every ship-gate viewport. Seeded straight through the
// notifications API — status defaults to 'pending'.
//
// An ask belongs to the reader only when it targets them (target_actor_id ===
// the signed-in actor), so every seeded ask below sets target_actor_id to the
// reader's own actor id, and the final test pins the negative case: an ask
// aimed at a different actor shows no pill for this reader.

test.describe('List row — pending-ask line + pill (ship gate)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`pending ask renders the line + "Waiting on you" pill @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const source = await createTestActor({ name: 'Asker Bot' })
			const object = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Ask Line Test Bet',
				status: 'signal',
			})
			await account.api.createNotification(account.workspaceId, {
				type: 'needs_input',
				title: 'Approve this bet',
				content: 'Approve this bet',
				source_actor_id: source.id,
				object_id: object.id,
				target_actor_id: account.actorId,
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Ask Line Test Bet')).toBeVisible({ timeout: 10000 })

			// The pill is the shorthand; the ask line carries actor + text.
			await expect(page.getByText('Waiting on you')).toBeVisible()
			// The line names the asking actor; a source actor outside this
			// workspace's member list reads as the generic "Agent". Only the actor
			// name is its own span now ({who} asks — "{text}" splits the phrase
			// across nodes), so match the phrase against the line.
			await expect(page.getByText(/^Agent asks —/)).toBeVisible()
			await expect(page.getByText(/approve this bet/i).first()).toBeVisible()
		})
	}

	// The pill sits on `bg-accent` — per the accent-pairing rule it carries a
	// `text-accent-foreground` child, so it must stay readable in both schemes.
	for (const colorScheme of ['light', 'dark'] as const) {
		test(`"Waiting on you" pill is visible in ${colorScheme} mode`, async ({ page, account }) => {
			await page.setViewportSize(SHIP_GATE_VIEWPORTS[0] ?? { width: 375, height: 812 })
			await page.emulateMedia({ colorScheme })
			const source = await createTestActor({ name: 'Asker Bot' })
			const object = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Ask Scheme Test Bet',
				status: 'signal',
			})
			await account.api.createNotification(account.workspaceId, {
				type: 'needs_input',
				title: 'Approve this bet',
				content: 'Approve this bet',
				source_actor_id: source.id,
				object_id: object.id,
				target_actor_id: account.actorId,
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Ask Scheme Test Bet')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Waiting on you')).toBeVisible()
		})
	}

	// Regression guard for the reported bug: an ask that targets a different
	// actor (or nobody) must not light up a personal "Waiting on you" signal for
	// this reader — that is the "waiting on me with nothing to do" symptom.
	test('an ask targeting another actor shows no "Waiting on you" for this reader', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(SHIP_GATE_VIEWPORTS[0] ?? { width: 375, height: 812 })
		const source = await createTestActor({ name: 'Asker Bot' })
		const other = await createTestActor({ name: 'Someone Else' })
		const object = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Not My Ask Bet',
			status: 'signal',
		})
		await account.api.createNotification(account.workspaceId, {
			type: 'needs_input',
			title: 'Approve this bet',
			content: 'Approve this bet',
			source_actor_id: source.id,
			object_id: object.id,
			target_actor_id: other.id,
		})

		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText('Not My Ask Bet')).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('Waiting on you')).toHaveCount(0)
	})
})
