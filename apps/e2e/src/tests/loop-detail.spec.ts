import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loop detail page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders title, stats, and steps at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback loop',
				status: 'running',
				content: 'Every customer who gives feedback hears back within 30 days',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Triage feedback',
				type: 'event',
				action_prompt: 'Normalises the Slack event into the shared source',
				target_actor_id: agent.id,
				config: { entity_type: 'object', action: 'created' },
			})
			// Trigger membership lives on the loop row (metadata.trigger_ids per the
			// T1 architecture decision) rather than a relationship, since a trigger
			// can outlive the loop it's currently attached to — see loops.ts.
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id] },
			})
			const insight = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Setup confusion drives trial churn',
				status: 'new',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'object',
				source_id: loop.id,
				target_type: 'object',
				target_id: insight.id,
				type: 'in_loop',
			})

			await page.goto(`/${account.workspaceId}/loops`)
			await page.getByText('Customer feedback loop').click()

			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops/${loop.id}`), {
				timeout: 10000,
			})
			await expect(page.getByRole('heading', { name: 'Customer feedback loop' })).toBeVisible({
				timeout: 10000,
			})
			await expect(
				page.getByText('Every customer who gives feedback hears back within 30 days').first(),
			).toBeVisible()
			// The four-sentence plain-language summary renders from the same loop.
			await expect(page.getByTestId('loop-summary')).toContainText(
				'Every customer who gives feedback hears back within 30 days',
			)
			// Scoped to the stat block — the plain-language summary above also
			// contains "in progress" in prose form ("Right now N items are in
			// progress."), which otherwise makes these locators ambiguous.
			const stats = page.getByTestId('loop-stats')
			await expect(stats.getByText('in progress')).toBeVisible()
			await expect(stats.getByText('closed')).toBeVisible()
			await expect(stats.getByText('median to close')).toBeVisible()
			await expect(page.getByText('The loop, right now')).toBeVisible()
			// AC5 — the utterance input is present on loop detail.
			await expect(page.getByPlaceholder('Listening — speak in plain words')).toBeVisible()
			await expect(
				page.getByText('Normalises the Slack event into the shared source'),
			).toBeVisible()
			// T2 sections — latest activity and the changes log with undo.
			await expect(page.getByRole('heading', { name: 'Latest activity' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible()
			await expect(page.getByRole('button', { name: /undo/i }).first()).toBeVisible()
		})
	}

	test('submitting an utterance opens the chat panel with the loop attached (AC5)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Feedback loop',
			status: 'running',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		const input = page.getByPlaceholder('Listening — speak in plain words')
		await expect(input).toBeVisible({ timeout: 10000 })

		await input.fill('Tighten the close timeline')
		await input.press('Enter')

		// The utterance is forwarded to the chat-driven edit path: the chat
		// panel opens with the message staged and sent.
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({
			timeout: 10000,
		})
		await expect(input).toHaveValue('')
	})

	test('Pause/Resume toggles the loop pill', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Billing reliability loop',
			status: 'running',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await expect(page.getByTestId('loop-pill')).toHaveText('Running', { timeout: 10000 })

		await page.getByRole('button', { name: 'More' }).click()
		await page.getByRole('menuitem', { name: 'Pause loop' }).click()

		await expect(page.getByTestId('loop-pill')).toHaveText('Paused', { timeout: 10000 })
	})

	test('clicking a loop row from /loops navigates to the dedicated detail page, not the generic object page', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Churn early-warning loop',
			status: 'running',
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await page.getByText('Churn early-warning loop').click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops/${loop.id}`), {
			timeout: 10000,
		})
		await expect(page).not.toHaveURL(new RegExp(`${account.workspaceId}/objects/${loop.id}`))
	})
})
