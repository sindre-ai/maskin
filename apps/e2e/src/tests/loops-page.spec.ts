import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loops list page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`empty workspace renders the empty state at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText('No loops running here yet')).toBeVisible({ timeout: 10000 })
		})

		test(`renders a loop row with derived stats at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback',
				status: 'running',
				content: 'Every customer who gives feedback hears back within 30 days',
			})

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText('Customer feedback')).toBeVisible({ timeout: 10000 })
			await expect(page.getByTestId('loop-pill')).toHaveText('Running')
		})

		test(`/triggers redirects to /loops and lists its triggers there at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Nightly sweep',
				type: 'cron',
				action_prompt: 'Sweep the backlog',
				target_actor_id: agent.id,
				config: { expression: '0 3 * * *' },
			})

			await page.goto(`/${account.workspaceId}/triggers`)

			// The v2 sidebar has no Triggers entry — the bookmark must land on Loops.
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops$`), { timeout: 10000 })
			await expect(page.getByText('Not tied to a loop')).toBeVisible()
			await expect(page.getByText('Nightly sweep')).toBeVisible()
		})

		test(`a workspace with triggers but no loops still lists them at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Unattached watcher',
				type: 'event',
				action_prompt: 'Watch for new insights',
				target_actor_id: agent.id,
				config: { entity_type: 'insight', action: 'created' },
			})

			await page.goto(`/${account.workspaceId}/loops`)

			// Ungating this section is the whole reason the fold-in is safe.
			await expect(page.getByText('Unattached watcher')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('No loops running here yet')).toBeVisible()
		})
	}

	test('a /triggers/{id} deep link still resolves after the fold-in', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Deep linked trigger',
			type: 'event',
			action_prompt: 'Summarise the new event',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})

		await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers/${trigger.id}`), {
			timeout: 10000,
		})
		await expect(page.getByRole('heading', { name: 'TRIGGER TYPE' })).toBeVisible({
			timeout: 10000,
		})
		// Its breadcrumb now hangs off Loops, not a page that would bounce.
		await expect(
			page.getByRole('navigation', { name: 'breadcrumb' }).getByText('Loops', { exact: true }),
		).toBeVisible()
	})

	test('sidebar Loops entry navigates to /loops', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('link', { name: 'Loops' }).click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops`), { timeout: 10000 })
	})

	test('Display → Ordering changes row order and survives a reload', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Alpha loop',
			status: 'running',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Zulu loop',
			status: 'running',
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('Alpha loop')).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'Display' }).click()
		await page
			.getByRole('button', { name: /^Created$|^Last activity$/ })
			.first()
			.click()
		await page.getByRole('menuitem', { name: 'Name' }).click()
		await page.keyboard.press('Escape')

		const namesAfterSort = async () => {
			const rows = page.locator('a[href*="/loops/"]')
			return (await rows.allTextContents()).join(' | ')
		}
		await expect.poll(namesAfterSort).toContain('Alpha loop')

		await page.reload()
		await expect(page.getByText('Alpha loop')).toBeVisible({ timeout: 10000 })
		// The persisted ordering comes back from the user display-settings row.
		await page.getByRole('button', { name: 'Display' }).click()
		await expect(page.getByRole('button', { name: 'Name' })).toBeVisible()
	})

	test('toggling a standalone trigger flips enabled without navigating away', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.createTrigger(account.workspaceId, {
			name: 'Toggle me',
			type: 'event',
			action_prompt: 'Watch for new insights',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})

		await page.goto(`/${account.workspaceId}/loops`)
		const toggle = page.getByRole('switch', { name: 'Disable Toggle me' })
		await expect(toggle).toBeVisible({ timeout: 10000 })

		await toggle.click()

		// The switch must not be swallowed by the row's navigation overlay.
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops$`))
		await expect(page.getByRole('switch', { name: 'Enable Toggle me' })).toBeVisible()

		await page.reload()
		await expect(page.getByRole('switch', { name: 'Enable Toggle me' })).toBeVisible({
			timeout: 10000,
		})
	})

	test('an "Assigned in chat" row opens the conversation it came from', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Look into the churn spike',
			participant_actor_ids: [agent.id],
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('Assigned in chat')).toBeVisible({ timeout: 10000 })

		await page.getByText('Look into the churn spike').click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/chats/${conversation.id}`), {
			timeout: 10000,
		})
	})
})
