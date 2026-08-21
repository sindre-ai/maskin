import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loops list page', () => {
	// Empty-state rendering for the Loops list is already covered at the
	// component level (loops-index.test.tsx via a mocked empty list). An E2E
	// "empty workspace" check was removed here for the same reason a matching
	// one was removed from states-vocabulary.spec.ts: new workspaces auto-seed
	// the Discovery -> Bet and Workspace Improvements loops (#1433), so a
	// genuinely loop-free workspace isn't reliably reachable through the real
	// signup flow this fixture uses. See CI run for PR #1403.

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders a loop row with derived stats at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback',
				status: 'learning',
				content: 'Every customer who gives feedback hears back within 30 days',
			})

			await page.goto(`/${account.workspaceId}/loops`)

			// Workspaces now come with the Discovery -> Bet and Workspace
			// Improvements loops pre-seeded (#1433), so scope every assertion to
			// this test's own row instead of the page as a whole.
			const row = page.getByRole('link', { name: /Customer feedback/ })
			await expect(row).toBeVisible({ timeout: 10000 })
			await expect(row.getByTestId('loop-pill')).toHaveText('Learning')
			await expect(row.getByText(/in progress/i)).toBeVisible()
		})
	}

	test('sidebar Loops entry navigates to /loops @smoke', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('link', { name: 'Loops' }).click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops`), { timeout: 10000 })
		await expect(
			page.getByRole('navigation', { name: 'breadcrumb' }).getByText('Loops', { exact: true }),
		).toBeVisible()
	})

	test('triggers page continues to render for workspaces with only triggers', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		// Workspaces no longer come with default agents/triggers pre-seeded
		// (#1419 stopped auto-seeding on workspace creation) — create one
		// explicitly so the list has a row to render.
		const agent = await account.api.createAgentActor('Trigger Test Agent')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.createTrigger(account.workspaceId, {
			name: 'Weekly check-in',
			type: 'cron',
			action_prompt: 'Summarize the week',
			target_actor_id: agent.id,
			config: { expression: '0 17 * * 0' },
		})

		await page.goto(`/${account.workspaceId}/triggers`)

		await expect(
			page.getByRole('navigation', { name: 'breadcrumb' }).getByText('Triggers', { exact: true }),
		).toBeVisible({ timeout: 10000 })
		// This asserts the list itself renders, verifying the extraction of
		// TriggerRow into a shared component did not regress the Triggers
		// surface. describeTrigger() has rendered cron schedules in plain
		// English since a342963f (e.g. "Runs every Sunday at 5:00 PM"), not the
		// old raw-cron "Runs on schedule: ..." copy — pin the stable "Runs "
		// prefix instead.
		await expect(page.getByText(/^Runs /).first()).toBeVisible()
	})
})
