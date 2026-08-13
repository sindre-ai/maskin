import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Verifies the bet status indicator at 375/768/1024 viewports. The objects
// overview rows keep the read-only derived indicator; the rebuilt detail
// header (bet/object-detail, T1) renders status as an editable combobox, so
// the header tests pin the raw-status control and the absence of the
// derived chip markup (which is not part of the T1 surface).

test.describe('Bet status indicator', () => {
	test('bet with no children shows its raw status in the header status control', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with no children',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		// Scoped to main — the sidebar workspace switcher can render a label
		// that collides with the bet title (E2E workspace names are derived
		// from the test title, which often contains the bet title as a substring).
		await expect(page.getByRole('heading', { level: 1, name: 'Bet with no children' })).toBeVisible(
			{ timeout: 10000 },
		)

		// The rebuilt shell (bet/object-detail, T1) renders the header status as
		// an editable combobox in the identity row — the derived read-only chip
		// (idle/progressing/waiting on human) remains on the objects overview
		// rows (tests below) and is not part of the T1 header surface.
		const statusControl = page
			.getByRole('combobox')
			.filter({ hasNotText: /driver/i })
			.first()
		await expect(statusControl).toBeVisible()
		await expect(statusControl).toHaveText('active')
		await expect(page.locator('main').getByRole('button', { name: /^Status: /i })).toHaveCount(0)
	})

	// A stale in_progress child (no live agent session) must not leak a
	// derived "progressing" chip onto the T1 header — the raw-status
	// combobox is the only status affordance there.
	test('header shows the raw status and never the derived chip states', async ({
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
		await expect(
			page.getByRole('heading', { level: 1, name: 'Bet with stale in_progress task' }),
		).toBeVisible({ timeout: 10000 })

		// Header status is the raw-status combobox on T1; the derived chip states
		// are not rendered on this surface, so neither "progressing" nor "idle"
		// chip markup may appear.
		const statusControl = page
			.getByRole('combobox')
			.filter({ hasNotText: /driver/i })
			.first()
		await expect(statusControl).toHaveText('active')
		await expect(page.locator('main').getByRole('button', { name: /^Status: /i })).toHaveCount(0)
	})

	test('human_decision task keeps the header status raw, with no derived waiting chip', async ({
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
		await expect(
			page.getByRole('heading', { level: 1, name: 'Bet blocked on decision' }),
		).toBeVisible({ timeout: 10000 })

		// The "waiting on human" derived chip and its popover are not part of the
		// T1 header surface (status is the editable combobox); the human-decision
		// state still surfaces as the indicator on the objects overview rows.
		const statusControl = page
			.getByRole('combobox')
			.filter({ hasNotText: /driver/i })
			.first()
		await expect(statusControl).toHaveText('active')
		await expect(page.locator('main').getByRole('button', { name: /^Status: /i })).toHaveCount(0)
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
			await expect(page.locator('main').getByText(`Overview bet ${vp.width}`)).toBeVisible({
				timeout: 10000,
			})

			// Same lowercase "waiting" word is rendered on the row indicator (no
			// "on human" suffix — that's the chip variant only).
			await expect(page.getByLabel('Status: waiting').first()).toBeVisible()
		})
	}
})
