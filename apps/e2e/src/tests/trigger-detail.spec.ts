import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// The DoD render gate calls out 1280px and 375px; the ship-gate list tops out
// at 1024px, so add the standard desktop to close the wide-breakpoint gap.
const RENDER_VIEWPORTS = [...SHIP_GATE_VIEWPORTS, VIEWPORTS.desktopXl]

test.describe('Trigger detail page', () => {
	for (const viewport of RENDER_VIEWPORTS) {
		test(`renders the one-page trigger form at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Triage events',
				type: 'event',
				action_prompt: 'Summarise the new event into the shared source',
				target_actor_id: agent.id,
				config: { entity_type: 'insight', action: 'created' },
			})

			await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers/${trigger.id}`), {
				timeout: 10000,
			})

			// Every trigger section is on the one stored page.
			await expect(page.getByRole('radio', { name: /Event/i })).toBeVisible({ timeout: 10000 })
			await expect(page.getByRole('radio', { name: /Schedule/i })).toBeVisible()
			await expect(page.getByRole('radio', { name: /Reminder/i })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'When it fires' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Do this' })).toBeVisible()
			await expect(page.getByText('What happens')).toBeVisible()
			await expect(page.getByText('Summarise the new event into the shared source')).toBeVisible()

			// The plain-language summary reflects the current event config.
			const summary = page.getByText('What happens').locator('xpath=..')
			await expect(summary).toContainText('When a insight is created')
			await expect(summary).toContainText('Relay')
		})
	}

	test('switching the trigger type swaps the section description and summary in place', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Hourly digest',
			type: 'event',
			action_prompt: 'Send a digest of new insights',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})

		await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)

		// Default section description is the event one.
		await expect(page.getByText(/Fires when something happens/i)).toBeVisible({ timeout: 10000 })

		// Click the visible card (a <label htmlFor> that forwards to the radio),
		// matching how a real user switches type.
		await page.getByText('Recurring schedule', { exact: true }).click()

		// The per-type description text updates in place.
		await expect(page.getByText(/Fires on a recurring schedule/i)).toBeVisible()
		// The pinned summary re-renders live to the schedule.
		const summary = page.getByText('What happens').locator('xpath=..')
		await expect(summary).toContainText('Runs every day')
		await expect(summary).toContainText('prompted to act')
	})

	test('autosave emits trigger_updated and shows the Saved indicator after an edit', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Edit me',
			type: 'cron',
			action_prompt: 'Summarise weekly',
			target_actor_id: agent.id,
			config: { expression: '0 9 * * 1' },
		})

		await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)

		// A saved trigger shows the enabled pill + sticky save bar.
		await expect(page.getByText('Enabled')).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('Editing — every change saves automatically')).toBeVisible()

		const prompt = page.getByPlaceholder(
			'Describe what the agent should do when this trigger fires...',
		)
		await prompt.fill('Summarise weekly and send the report')

		// Autosave fires after the debounce and fades the Saved indicator in.
		// The span is always mounted (opacity-0 -> opacity-100 on save), so assert
		// the opacity transition rather than visibility, which ignores opacity.
		await expect(page.getByText('Saved')).toHaveCSS('opacity', '1', { timeout: 10000 })
	})
})
