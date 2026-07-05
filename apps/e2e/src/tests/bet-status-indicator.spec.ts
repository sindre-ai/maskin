import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Verifies T3 surface wiring — the read-only bet status indicator on the
// objects overview row and the bet detail header, at 375/768/1024 viewports.

test.describe('Bet status indicator', () => {
	test('bet with no children renders as idle on the detail header, popover opens on click', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with no children',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByText('Bet with no children')).toBeVisible({ timeout: 10000 })

		const chip = page.getByRole('button', { name: 'Status: idle' })
		await expect(chip).toBeVisible()
		await chip.click()
		await expect(page.getByText(/No open human decisions/i)).toBeVisible()
	})

	// `activeSessionId` — required for "progressing" since it now gates on a
	// live agent session, not just task status — is only ever set by a real
	// triggered container session (trigger-runner.ts) and cleared when that
	// session ends. There's no public API to fake one, so the "progressing"
	// chip render itself is covered at the component level instead (see
	// indicator-badge.test.tsx). This spec instead guards the behavior that
	// motivated the gate: a task merely marked in_progress (e.g. by a human,
	// or left stale after its session already ended) must NOT read as
	// "progressing".
	test('bet with in-progress child task but no live agent session renders as idle, not progressing', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with stale in_progress task',
			status: 'active',
		})
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Ship the widget',
			status: 'in_progress',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'bet',
			source_id: bet.id,
			target_type: 'task',
			target_id: task.id,
			type: 'breaks_into',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByText('Bet with stale in_progress task')).toBeVisible({ timeout: 10000 })

		await expect(page.getByRole('button', { name: 'Status: progressing' })).not.toBeVisible()
		await expect(page.getByRole('button', { name: 'Status: idle' })).toBeVisible()
	})

	test('open human_decision task flips the state to "waiting on human" and shows the task title in the popover header', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet blocked on decision',
			status: 'active',
		})
		const decision = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Approve pricing tier',
			status: 'todo',
			metadata: { human_decision: true },
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'bet',
			source_id: bet.id,
			target_type: 'task',
			target_id: decision.id,
			type: 'breaks_into',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByText('Bet blocked on decision')).toBeVisible({ timeout: 10000 })

		const chip = page.getByRole('button', { name: 'Status: waiting on human' })
		await expect(chip).toBeVisible()
		await chip.click()
		await expect(page.getByText('Waiting: Approve pricing tier')).toBeVisible()
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`objects overview row shows the indicator for a bet at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Overview bet ${vp.width}`,
				status: 'active',
			})
			const decision = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Answer pricing question',
				status: 'todo',
				metadata: { human_decision: true },
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: bet.id,
				target_type: 'task',
				target_id: decision.id,
				type: 'breaks_into',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText(`Overview bet ${vp.width}`)).toBeVisible({ timeout: 10000 })

			// Same lowercase "waiting" word is rendered on the row indicator (no
			// "on human" suffix — that's the chip variant only).
			await expect(page.getByLabel('Status: waiting').first()).toBeVisible()
		})
	}
})
